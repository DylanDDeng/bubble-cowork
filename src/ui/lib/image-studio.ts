import { loadPreferredKimiPermissionMode } from '../utils/kimi-permission';
import { loadPreferredGrokReasoningEffort } from '../utils/grok-reasoning';
import { createContext } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useImageStudioStore } from '../store/useImageStudioStore';
import { useComposerQueueStore } from '../store/useComposerQueueStore';
import { collectStudioImages, imageEditEffectivePrompt, supportsImageStudio } from '../utils/image-studio';
import type { Attachment } from '../types';
import type { CodexReferencePayload } from '../utils/codex-composer';

export const ImageStudioSessionContext = createContext<string | null>(null);

export function openImageStudio(sessionId: string, path: string, view: 'single' | 'canvas' = 'single'): boolean {
  const store = useAppStore.getState();
  const session = store.sessions[sessionId];
  if (!session || !supportsImageStudio(session.provider)) return false;
  useImageStudioStore.getState().patch(sessionId, { activePath: path, activePendingId: undefined, view });
  store.setActiveRightUtilityTab(`images:${sessionId}`);
  store.setRightPanelFullscreen('images');
  return true;
}

export async function importStudioImages(paths: string[]): Promise<Attachment[]> {
  // Import individually so provider image order always matches numbered comments.
  const attachments: Attachment[] = [];
  for (const path of paths) {
    const result = await window.electron.importAttachments([path]);
    if (result.errors.length || result.attachments.length !== 1 || result.attachments[0].kind !== 'image') {
      throw new Error(result.errors.join('\n') || `Could not attach ${path}`);
    }
    attachments.push(result.attachments[0]);
  }
  return attachments;
}

export async function resolveImageStudioReferences(cwd?: string | null): Promise<CodexReferencePayload> {
  if (!window.electron.listCodexSkills) return {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    window.electron.listCodexSkills({ cwd: cwd || undefined }).catch(() => null),
    new Promise<null>(resolve => { timeout = setTimeout(() => resolve(null), 3000); }),
  ]);
  clearTimeout(timeout);
  const skill = result?.skills.find(skill => skill.enabled && /(?:^|[:/])imagegen$|^image-generation$/i.test(skill.name));
  return skill ? { codexSkills: [{ name: skill.name, path: skill.path }] } : {};
}

const importing = new Set<string>();

export async function submitImageEdit(sessionId: string, prompt: string, paths: string[], mask?: Blob): Promise<'sent' | 'queued'> {
  const initial = useAppStore.getState().sessions[sessionId];
  if (!initial || initial.readOnly || !supportsImageStudio(initial.provider) || !paths.length || !prompt.trim()) throw new Error('Image editing is unavailable for this task.');
  if (importing.has(sessionId) || useImageStudioStore.getState().sessions[sessionId]?.pending) throw new Error('An image edit is already pending.');
  importing.add(sessionId);
  try {
    const provider = initial.provider as 'codex' | 'grok';
    // Unlike Codex, a resumed Grok process does not restore these from the
    // application's session database. Carry the user's existing choices.
    const configuration = {
      model: initial.model,
      ...(provider === 'grok' ? {
        grokPermissionMode: initial.grokPermissionMode ?? loadPreferredKimiPermissionMode(),
        grokReasoningEffort: initial.grokReasoningEffort ?? loadPreferredGrokReasoningEffort(initial.model || null) ?? undefined,
      } : {
        codexExecutionMode: initial.codexExecutionMode,
        codexPermissionMode: initial.codexPermissionMode,
        codexReasoningEffort: initial.codexReasoningEffort,
        codexFastMode: initial.codexFastMode,
      }),
    };
    const references = provider === 'codex' ? await resolveImageStudioReferences(initial.cwd) : {};
    const attachments = await importStudioImages(paths);
    if (mask) attachments.push(await window.electron.createFileAttachment('image-mask.png', new Uint8Array(await mask.arrayBuffer())));
    // Do not dispatch into a deleted task or a provider changed during attachment import.
    const current = useAppStore.getState().sessions[sessionId];
    if (!current || current.readOnly || current.provider !== provider || current.cwd !== initial.cwd) throw new Error('The task changed. Please try again.');
    const effectivePrompt = imageEditEffectivePrompt(provider, prompt, [...paths, ...(mask ? [attachments.at(-1)!.path] : [])]);
    const dispatch = () => {
      const session = useAppStore.getState().sessions[sessionId];
      if (!session || session.readOnly || session.provider !== provider || session.cwd !== initial.cwd) {
        useImageStudioStore.getState().patch(sessionId, { pending: undefined, activePendingId: undefined, feedback: 'The task changed. The image edit was cancelled.' });
        return;
      }
      if (!window.electron.sendClientEvent) throw new Error('The agent connection is unavailable.');
      window.electron.sendClientEvent({ type: 'session.continue', payload: {
        sessionId, prompt, effectivePrompt, attachments, provider, ...configuration, ...references,
        // Keep the same configuration for both direct and queued edits.
        teamMode: 'solo', teamId: null,
      } });
    };
    const item = {
      id: crypto.randomUUID(), displayPrompt: prompt, effectivePrompt, attachments, references, exclusive: true, dispatch,
      onRemove: () => useImageStudioStore.getState().patch(sessionId, { pending: undefined, activePendingId: undefined, feedback: 'Edit cancelled' }),
    };
    const queued = current.status === 'running' || current.status === 'stopping' || current.permissionRequests.length > 0;
    useImageStudioStore.getState().patch(sessionId, { feedback: undefined, activePendingId: item.id, pending: {
      id: item.id, baseline: collectStudioImages(current.messages, current.cwd).map(image => image.path),
      queued, sawRunning: false, startedAt: Date.now(),
    } });
    monitorImageEdit(sessionId, item.id, prompt, current.messages.length, provider);
    if (queued) useComposerQueueStore.getState().enqueue(sessionId, item);
    else dispatch();
    return queued ? 'queued' : 'sent';
  } catch (error) {
    useImageStudioStore.getState().patch(sessionId, { pending: undefined, activePendingId: undefined });
    throw error;
  } finally { importing.delete(sessionId); }
}

export function cancelQueuedImageEdit(sessionId: string) {
  const pending = useImageStudioStore.getState().sessions[sessionId]?.pending;
  if (!pending?.queued) return;
  if (!useComposerQueueStore.getState().queues[sessionId]?.some(item => item.id === pending.id)) return;
  useComposerQueueStore.getState().remove(sessionId, pending.id);
  useImageStudioStore.getState().patch(sessionId, { pending: undefined, activePendingId: undefined, feedback: 'Edit cancelled' });
}

// Independent of panel mounting: switching tasks or closing a tab does not lose completion.
function monitorImageEdit(sessionId: string, id: string, prompt: string, messageCount: number, provider: string) {
  let lastQueued = useImageStudioStore.getState().sessions[sessionId]?.pending?.queued;
  let dispatchAt = Date.now();
  const timer = setInterval(() => {
    const state = useImageStudioStore.getState();
    const pending = state.sessions[sessionId]?.pending;
    if (!pending || pending.id !== id) { clearInterval(timer); return; }
    const session = useAppStore.getState().sessions[sessionId];
    const finish = (feedback?: string, activePath?: string) => {
      clearInterval(timer);
      state.patch(sessionId, { pending: undefined, activePendingId: undefined, feedback,
        ...(activePath && state.sessions[sessionId]?.activePendingId === id ? { activePath, comments: {}, selected: [] } : {}) });
    };
    if (!session || session.provider !== provider || session.readOnly) { finish('Image editing is no longer available for this task.'); return; }
    if (pending.queued && useComposerQueueStore.getState().queues[sessionId]?.some(item => item.id === id)) return;
    if (lastQueued) { dispatchAt = Date.now(); lastQueued = false; }
    const recent = session.messages.slice(messageCount);
    const editPromptIndex = recent.findIndex(message => message.type === 'user_prompt' && message.prompt === prompt);
    const started = editPromptIndex >= 0 || (!pending.queued && session.status === 'running');
    if (started && !pending.sawRunning) state.patch(sessionId, { pending: { ...pending, queued: false, sawRunning: true } });
    if (started || pending.sawRunning) {
      const results = collectStudioImages(editPromptIndex >= 0 ? recent.slice(editPromptIndex) : recent, session.cwd);
      const result = results.filter(image => !pending.baseline.includes(image.path)).at(-1);
      // Image arrival is not turn completion: the agent may still review it
      // or request permission. Keep that lifecycle visible until it settles.
      if (result && result.path !== pending.resultPath) state.patch(sessionId, {
        pending: { ...pending, queued: false, sawRunning: true, resultPath: result.path },
        ...(state.sessions[sessionId]?.activePendingId === id ? { activePath: result.path, activePendingId: undefined, comments: {}, selected: [] } : {}),
      });
      if (session.status === 'error' || (session.status !== 'running' && session.status !== 'stopping' && !session.permissionRequests.length)) {
        if (session.status === 'completed' && result) finish(undefined, result.path);
        else finish(session.status === 'error'
          ? result ? 'An image was saved, but the turn failed. See the task for details.' : 'Image editing failed. See the task for details.'
          : result ? 'The turn stopped after saving an image.' : 'The turn ended without a new image. Check the agent reply in the task.');
      }
    } else if (Date.now() - dispatchAt > 30000) {
      finish('The edit has not started. Check the task and its queue before trying again.');
    }
  }, 500);
}
