import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Copy, FileText, FolderOpen, Link, LoaderCircle, Mic, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import { getMessageContentBlocks } from '../../utils/message-content';
import { loadPreferredProvider } from '../../utils/provider';
import {
  formatClaudeModelLabel,
  loadPreferredClaudeCompatibleProviderId,
  loadPreferredClaudeContext1m,
  loadPreferredClaudeModel,
  supportsClaude1mContext,
} from '../../utils/claude-model';
import { formatCodexModelLabel, loadPreferredCodexModel } from '../../utils/codex-model';
import { loadPreferredCodexPermissionMode } from '../../utils/codex-permission';
import { formatOpencodeModelLabel, loadPreferredOpencodeModel } from '../../utils/opencode-model';
import type {
  AgentProvider,
  PodcastDuration,
  PodcastPacing,
  PodcastDraftView,
  PodcastSourceKind,
  PodcastStyle,
  PodcastTtsVoice,
  PodcastTone,
  PodcastVoice,
} from '../../types';

const PACING_OPTIONS: Array<{ value: PodcastPacing; label: string }> = [
  { value: 'fast', label: '快节奏' },
  { value: 'balanced', label: '平衡' },
  { value: 'slow', label: '慢展开' },
];

const STYLE_OPTIONS: Array<{ value: PodcastStyle; label: string }> = [
  { value: 'conversational', label: '轻松对谈' },
  { value: 'deep_dive', label: '深度拆解' },
  { value: 'news_brief', label: '新闻快评' },
  { value: 'storytelling', label: '故事化讲述' },
  { value: 'debate', label: '辩论式' },
  { value: 'xiangsheng', label: '相声式' },
];

const TONE_OPTIONS: Array<{ value: PodcastTone; label: string }> = [
  { value: 'professional', label: '专业' },
  { value: 'casual', label: '轻松' },
  { value: 'opinionated', label: '有观点' },
];

const DURATION_OPTIONS: Array<{ value: PodcastDuration; label: string }> = [
  { value: '5m', label: '约 5 分钟' },
  { value: '10m', label: '约 10 分钟' },
  { value: '20m', label: '约 20 分钟' },
];

const VOICE_OPTIONS: Array<{ value: PodcastVoice; label: string }> = [
  { value: 'neutral', label: '中性' },
  { value: 'warm', label: '温和' },
  { value: 'energetic', label: '有活力' },
];

const MINIMAX_VOICE_OPTIONS: Array<{ value: PodcastTtsVoice; label: string }> = [
  { value: 'male-qn-jingying', label: '青年男声 · 精英感' },
  { value: 'male-qn-qingse', label: '青年男声 · 清澈感' },
  { value: 'male-qn-badao', label: '青年男声 · 低沉稳重' },
  { value: 'male-qn-daxuesheng', label: '青年男声 · 大学生' },
  { value: 'female-yujie', label: '御姐女声 · 成熟知性' },
  { value: 'female-shaonv', label: '少女女声 · 轻快明亮' },
  { value: 'female-tianmei', label: '甜美女声 · 柔和亲切' },
  { value: 'female-qingxinnvsheng', label: '清新女声 · 自然聊天' },
  { value: 'Chinese (Mandarin)_Radio_Host', label: '中文主持人 · 广播腔' },
  { value: 'Chinese (Mandarin)_Warm_Bestie', label: '中文女声 · 闺蜜感' },
  { value: 'Chinese (Mandarin)_Gentleman', label: '中文男声 · 绅士感' },
  { value: 'Chinese (Mandarin)_Sweet_Lady', label: '中文女声 · 甜美款' },
];

const MINIMAX_MODEL = 'speech-2.8-hd';

function isValidUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikeYouTubeUrl(value: string): boolean {
  if (!isValidUrl(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return /(^|\.)youtube\.com$/.test(url.hostname) || url.hostname === 'youtu.be';
  } catch {
    return false;
  }
}

function buildSourceTitle(kind: PodcastSourceKind, value: string): string {
  if (!isValidUrl(value)) {
    return value;
  }

  try {
    const url = new URL(value);

    if (kind === 'youtube') {
      const videoId = url.searchParams.get('v') || url.pathname.split('/').filter(Boolean).at(-1);
      return videoId ? `YouTube video · ${videoId}` : 'YouTube video';
    }

    return url.hostname.replace(/^www\./, '');
  } catch {
    return value;
  }
}

export function PodcastStudioView() {
  const {
    podcastDrafts,
    activePodcastDraftId,
    projectCwd,
    sessions,
    createPodcastDraft,
    renamePodcastDraft,
    addPodcastSource,
    removePodcastSource,
    setProjectCwd,
    updatePodcastDraftConfig,
    updatePodcastDraftTranscript,
    setPodcastScriptGeneration,
    setPodcastScriptContent,
    setPodcastScriptError,
    setPodcastAudioGeneration,
    setPodcastAudioReady,
    setPodcastAudioError,
  } = useAppStore();
  const [sourceKind, setSourceKind] = useState<PodcastSourceKind>('youtube');
  const [sourceValue, setSourceValue] = useState('');
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [minimaxApiKey, setMinimaxApiKey] = useState('');
  const [ttsConfigLoading, setTtsConfigLoading] = useState(false);
  const [ttsConfigSaving, setTtsConfigSaving] = useState(false);

  const activeDraft = activePodcastDraftId ? podcastDrafts[activePodcastDraftId] : null;
  const generationAgentLabel = useMemo(() => getPreferredGenerationAgentLabel(), []);
  const youtubeSource = useMemo(
    () => activeDraft?.sources.find((source) => source.kind === 'youtube') || null,
    [activeDraft]
  );
  const generationSession = activeDraft?.scriptSessionId ? sessions[activeDraft.scriptSessionId] : null;
  const sourceCountLabel = useMemo(() => {
    if (!activeDraft) {
      return 'No sources yet';
    }

    return `${activeDraft.sources.length} source${activeDraft.sources.length === 1 ? '' : 's'} ready`;
  }, [activeDraft]);

  useEffect(() => {
    if (typeof window.electron.getMiniMaxTtsConfig !== 'function') {
      return;
    }

    let cancelled = false;

    const loadConfig = async () => {
      try {
        setTtsConfigLoading(true);
        const config = await window.electron.getMiniMaxTtsConfig();
        if (!cancelled) {
          setMinimaxApiKey(config.apiKey || '');
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Failed to load MiniMax settings.';
          toast.error(message);
        }
      } finally {
        if (!cancelled) {
          setTtsConfigLoading(false);
        }
      }
    };

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!activeDraft || activeDraft.scriptStatus !== 'generating' || !activeDraft.scriptSessionId) {
      return;
    }

    const linkedSession = sessions[activeDraft.scriptSessionId];
    if (!linkedSession) {
      return;
    }

    if (linkedSession.status === 'completed') {
      const script = extractAssistantText(linkedSession.messages);
      if (!script.trim()) {
        setPodcastScriptError(activeDraft.id, 'Script generation finished, but no assistant output was captured.');
        return;
      }

      setPodcastScriptContent(activeDraft.id, script);
      return;
    }

    if (linkedSession.status === 'error') {
      setPodcastScriptError(activeDraft.id, 'Script generation failed. Open the linked session to inspect the error.');
    }
  }, [activeDraft, sessions, setPodcastScriptContent, setPodcastScriptError]);

  const handleAddLinkSource = () => {
    if (!activeDraft) {
      return;
    }

    const value = sourceValue.trim();
    if (!value) {
      toast.error(sourceKind === 'youtube' ? 'Paste a YouTube URL first.' : 'Paste a web URL first.');
      return;
    }

    if (sourceKind === 'youtube' && !looksLikeYouTubeUrl(value)) {
      toast.error('Please enter a valid YouTube URL.');
      return;
    }

    if (sourceKind === 'web' && !isValidUrl(value)) {
      toast.error('Please enter a valid link.');
      return;
    }

    addPodcastSource(activeDraft.id, {
      kind: sourceKind,
      title: buildSourceTitle(sourceKind, value),
      value,
    });
    setSourceValue('');
  };

  const handleSourceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleAddLinkSource();
    }
  };

  const handleSelectProjectFolder = async () => {
    const selected = await window.electron.selectDirectory();
    if (!selected) {
      return;
    }

    setProjectCwd(selected);
    toast.success('Project folder selected.');
  };

  const handleFetchTranscript = async () => {
    if (!activeDraft || !youtubeSource) {
      toast.error('Add a YouTube source first.');
      return;
    }

    if (typeof window.electron.fetchYouTubeTranscript !== 'function') {
      toast.error('Podcast transcript API is unavailable. Restart the app to load the latest build.');
      return;
    }

    try {
      setTranscriptLoading(true);
      const result = await window.electron.fetchYouTubeTranscript(youtubeSource.value);
      updatePodcastDraftTranscript(activeDraft.id, result.transcript, 'youtube');
      toast.success(result.title ? `Loaded transcript for ${result.title}` : 'Transcript loaded.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch transcript.';
      setPodcastScriptError(activeDraft.id, message);
      toast.error(message);
    } finally {
      setTranscriptLoading(false);
    }
  };

  const handleGenerateScript = async () => {
    if (!activeDraft) {
      return;
    }

    if (!projectCwd?.trim()) {
      toast.error('Select a project folder first so the script job has a workspace.');
      return;
    }

    if (typeof window.electron.generatePodcastScript !== 'function') {
      toast.error('Podcast generation API is unavailable. Restart the app to load the latest build.');
      return;
    }

    let transcriptText = activeDraft.transcript.trim();
    if (!transcriptText && youtubeSource) {
      try {
        setTranscriptLoading(true);
        const result = await window.electron.fetchYouTubeTranscript(youtubeSource.value);
        transcriptText = result.transcript.trim();
        updatePodcastDraftTranscript(activeDraft.id, transcriptText, 'youtube');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch transcript.';
        const fallbackMessage = `${message} Paste the transcript manually, then retry.`;
        setPodcastScriptError(activeDraft.id, fallbackMessage);
        toast.error(fallbackMessage);
        return;
      } finally {
        setTranscriptLoading(false);
      }
    }

    if (!transcriptText && activeDraft.sources.length === 0) {
      toast.error('Add at least one source or paste a transcript before generating.');
      return;
    }

    try {
      const sessionId = await window.electron.generatePodcastScript(
        buildPodcastScriptRequest(activeDraft, projectCwd, transcriptText)
      );

      if (!sessionId) {
        toast.error('Failed to start script generation.');
        return;
      }

      setPodcastScriptGeneration(activeDraft.id, sessionId);
      toast.success('Generating podcast script...');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start script generation.';
      setPodcastScriptError(activeDraft.id, message);
      toast.error(message);
    }
  };

  const handleSaveMiniMaxKey = async () => {
    if (typeof window.electron.saveMiniMaxTtsConfig !== 'function') {
      toast.error('MiniMax settings API is unavailable. Restart the app to load the latest build.');
      return;
    }

    try {
      setTtsConfigSaving(true);
      const config = await window.electron.saveMiniMaxTtsConfig({ apiKey: minimaxApiKey });
      setMinimaxApiKey(config.apiKey || '');
      toast.success(config.apiKey ? 'MiniMax API key saved.' : 'MiniMax API key cleared.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save MiniMax API key.';
      toast.error(message);
    } finally {
      setTtsConfigSaving(false);
    }
  };

  const handleGenerateAudio = async () => {
    if (!activeDraft) {
      return;
    }

    if (!activeDraft.script.trim()) {
      toast.error('请先生成或粘贴口播稿，再生成音频。');
      return;
    }

    if (!minimaxApiKey.trim()) {
      toast.error('请先填写并保存 MiniMax API Key。');
      return;
    }

    if (typeof window.electron.generatePodcastAudio !== 'function') {
      toast.error('Podcast audio API is unavailable. Restart the app to load the latest build.');
      return;
    }

    try {
      if (typeof window.electron.saveMiniMaxTtsConfig === 'function') {
        await window.electron.saveMiniMaxTtsConfig({ apiKey: minimaxApiKey });
      }

      setPodcastAudioGeneration(activeDraft.id);
      const result = await window.electron.generatePodcastAudio({
        draftId: activeDraft.id,
        title: activeDraft.title,
        script: activeDraft.script,
        hostAVoiceId: activeDraft.config.ttsVoice,
        hostBVoiceId: activeDraft.config.ttsHostBVoice,
        speed: activeDraft.config.ttsSpeed,
        volume: activeDraft.config.ttsVolume,
        pitch: activeDraft.config.ttsPitch,
        format: 'mp3',
      });
      setPodcastAudioReady(activeDraft.id, result.outputPath);
      toast.success(`音频已生成，共 ${result.segmentCount} 段。`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate podcast audio.';
      setPodcastAudioError(activeDraft.id, message);
      toast.error(message);
    }
  };

  const handleCopyScript = async () => {
    if (!activeDraft?.script.trim()) {
      toast.error('No script to copy yet.');
      return;
    }

    await navigator.clipboard.writeText(activeDraft.script);
    toast.success('Script copied.');
  };

  const handleAddFiles = async () => {
    if (!activeDraft) {
      return;
    }

    const files = await window.electron.selectAttachments();
    if (!files || files.length === 0) {
      return;
    }

    for (const file of files) {
      addPodcastSource(activeDraft.id, {
        kind: 'file',
        title: file.name,
        value: file.path,
        filePath: file.path,
      });
    }
  };

  if (!activeDraft) {
    return (
      <div className="flex flex-1 min-w-0 items-center justify-center bg-[var(--bg-primary)] p-8">
        <div className="max-w-xl rounded-[28px] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-8 py-10 text-center shadow-sm">
          <div className="text-xl font-semibold text-[var(--text-primary)]">Podcast Studio</div>
          <div className="mt-3 text-sm leading-6 text-[var(--text-secondary)]">
            Start a podcast draft for YouTube videos, files, and links. We’ll use this workspace to shape the script, pacing, and audio pipeline.
          </div>
          <button
            type="button"
            onClick={() => createPodcastDraft()}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
          >
            <Plus className="h-4 w-4" />
            New podcast draft
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-w-0 flex-col bg-[var(--bg-primary)]">
      <div className="h-8 drag-region flex-shrink-0" />

      <div className="flex-1 overflow-auto px-8 pb-8 pt-4">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
          <div className="rounded-[28px] border border-[var(--border)] bg-[var(--bg-secondary)] p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
                  Podcast Workspace
                </div>
                <input
                  value={activeDraft.title}
                  onChange={(event) => renamePodcastDraft(activeDraft.id, event.target.value)}
                  className="mt-2 w-full bg-transparent text-2xl font-semibold text-[var(--text-primary)] outline-none"
                />
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  Build the episode workspace here: paste a YouTube link, attach source material, and generate a dual-host script with your current Aegis agent.
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5">
                    Output language · 中文
                  </span>
                  <span className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5">
                    Project folder · {projectCwd ? projectCwd : 'Not selected'}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleSelectProjectFolder()}
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 transition-colors hover:bg-[var(--bg-tertiary)]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    Select project folder
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-right">
                <div className="text-[11px] uppercase tracking-[0.14em] text-[var(--text-muted)]">Status</div>
                <div className="mt-1 text-sm font-semibold text-[var(--text-primary)]">
                  {activeDraft.audioStatus !== 'idle'
                    ? formatAudioStatus(activeDraft.audioStatus)
                    : formatScriptStatus(activeDraft.scriptStatus)}
                </div>
                <div className="mt-1 text-xs text-[var(--text-secondary)]">{sourceCountLabel}</div>
              </div>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
            <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-[var(--text-primary)]">Source Workspace</div>
                  <div className="text-sm text-[var(--text-secondary)]">Paste a YouTube link below, then mix in files or web links for extra context.</div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleAddFiles()}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <FolderOpen className="h-4 w-4" />
                  Add files
                </button>
              </div>

              <div className="mt-5 rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  Add source
                </div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  Start with YouTube for the MVP. We can still attach supporting notes, docs, or links.
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                {[
                  { value: 'youtube', label: 'YouTube' },
                  { value: 'web', label: 'Web link' },
                ].map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSourceKind(option.value as PodcastSourceKind)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      sourceKind === option.value
                        ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                        : 'border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
                </div>

                <div className="mt-4 flex gap-2">
                  <div className="relative flex-1">
                    <Link className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]" />
                    <input
                      value={sourceValue}
                      onChange={(event) => setSourceValue(event.target.value)}
                      onKeyDown={handleSourceKeyDown}
                      inputMode="url"
                      placeholder={
                        sourceKind === 'youtube'
                          ? 'https://www.youtube.com/watch?v=...'
                          : 'https://example.com/article'
                      }
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] py-2.5 pl-9 pr-3 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleAddLinkSource}
                    className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                  >
                    <Plus className="h-4 w-4" />
                    {sourceKind === 'youtube' ? 'Add video' : 'Add link'}
                  </button>
                </div>

                <div className="mt-3 text-xs text-[var(--text-muted)]">
                  {sourceKind === 'youtube'
                    ? 'Paste any youtube.com or youtu.be URL to seed the episode.'
                    : 'Paste an article or reference page to enrich the script.'}
                </div>
              </div>

              <div className="mt-5 space-y-3">
                {activeDraft.sources.length === 0 ? (
                  <div className="rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-4 py-8 text-sm text-[var(--text-secondary)]">
                    No sources yet. Start with a YouTube video, upload a file, or paste a web link.
                  </div>
                ) : (
                  activeDraft.sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex items-start gap-3 rounded-[18px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3"
                    >
                      <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                        {source.kind === 'file' ? <FolderOpen className="h-4 w-4" /> : <Link className="h-4 w-4" />}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-[var(--text-primary)]">{source.title}</div>
                        <div className="mt-1 text-xs text-[var(--text-secondary)] break-all">{source.value}</div>
                      </div>

                      <button
                        type="button"
                        onClick={() => removePodcastSource(activeDraft.id, source.id)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                        title="Remove source"
                        aria-label="Remove source"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="mt-5 rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-[var(--text-primary)]">Transcript</div>
                    <div className="mt-1 text-xs text-[var(--text-secondary)]">
                      Auto-fetch from YouTube when available, or paste your own transcript as the fallback source of truth.
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleFetchTranscript()}
                    disabled={!youtubeSource || transcriptLoading}
                    className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {transcriptLoading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                    Fetch transcript
                  </button>
                </div>

                <div className="mt-3 text-xs text-[var(--text-muted)]">
                  Source: {activeDraft.transcriptSource === 'youtube' ? 'YouTube subtitles' : activeDraft.transcriptSource === 'manual' ? 'Manual paste' : 'None yet'}
                </div>

                <textarea
                  value={activeDraft.transcript}
                  onChange={(event) => updatePodcastDraftTranscript(activeDraft.id, event.target.value, 'manual')}
                  placeholder="Transcript will appear here. If auto-fetch fails, paste the transcript manually and generate the script from this workspace."
                  className="mt-3 min-h-[180px] w-full rounded-2xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                />
              </div>
            </section>

            <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-sm">
              <div className="text-lg font-semibold text-[var(--text-primary)]">Script Settings</div>
              <div className="mt-1 text-sm text-[var(--text-secondary)]">这里主要控制口播稿怎么写；TTS 只是后面把稿子念出来，不决定文案风格。</div>

              <div className="mt-5 space-y-4">
                <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">Script style</div>
                  <div className="mt-2 text-sm text-[var(--text-secondary)]">下面这些选项会直接影响生成出来的中文双人口播稿。</div>
                  <div className="mt-4 space-y-4">
                <ConfigSelect
                  label="Pacing"
                  value={activeDraft.config.pacing}
                  options={PACING_OPTIONS}
                  onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { pacing: value as PodcastPacing })}
                />
                <ConfigSelect
                  label="Style"
                  value={activeDraft.config.style}
                  options={STYLE_OPTIONS}
                  onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { style: value as PodcastStyle })}
                />
                <ConfigSelect
                  label="Tone"
                  value={activeDraft.config.tone}
                  options={TONE_OPTIONS}
                  onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { tone: value as PodcastTone })}
                />
                <ReadOnlyConfig label="Format" value="Two hosts (Host A + Host B)" />
                <ConfigSelect
                  label="Target length"
                  value={activeDraft.config.duration}
                  options={DURATION_OPTIONS}
                  onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { duration: value as PodcastDuration })}
                />
                <ConfigSelect
                  label="Voice profile"
                  value={activeDraft.config.voice}
                  options={VOICE_OPTIONS}
                  onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { voice: value as PodcastVoice })}
                />
                  </div>
                </div>

                <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">MiniMax TTS</div>
                  <div className="mt-2 text-sm text-[var(--text-secondary)]">
                    这部分只影响最终音频怎么念，不参与文案生成。当前固定使用 `speech-2.8-hd`。
                  </div>

                  <div className="mt-4 space-y-4">
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <label className="min-w-0 flex-1">
                          <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                            API key
                          </div>
                          <input
                            type="password"
                            autoComplete="off"
                            value={minimaxApiKey}
                            onChange={(event) => setMinimaxApiKey(event.target.value)}
                            placeholder="请输入 MiniMax API Key"
                            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                          />
                        </label>

                        <button
                          type="button"
                          onClick={() => void handleSaveMiniMaxKey()}
                          disabled={ttsConfigLoading || ttsConfigSaving}
                          className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {ttsConfigSaving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                          保存 Key
                        </button>
                      </div>

                      <div className="mt-2 text-xs text-[var(--text-muted)]">
                        仅保存在本机 Aegis 配置中，不会写入项目文件。模型固定为 {MINIMAX_MODEL}。
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <ReadOnlyConfig label="Provider" value="MiniMax" />
                      <ReadOnlyConfig label="Output format" value="MP3" />
                      <ConfigSelect
                        label="Host A voice"
                        value={activeDraft.config.ttsVoice}
                        options={MINIMAX_VOICE_OPTIONS}
                        onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { ttsVoice: value as PodcastTtsVoice })}
                      />
                      <ConfigSelect
                        label="Host B voice"
                        value={activeDraft.config.ttsHostBVoice}
                        options={MINIMAX_VOICE_OPTIONS}
                        onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { ttsHostBVoice: value as PodcastTtsVoice })}
                      />
                    </div>

                    <RangeConfig
                      label="Speech speed"
                      min={0.5}
                      max={2}
                      step={0.05}
                      value={activeDraft.config.ttsSpeed}
                      startLabel="慢一点"
                      endLabel="快一点"
                      displayValue={`${activeDraft.config.ttsSpeed.toFixed(2)}x`}
                      onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { ttsSpeed: value })}
                    />

                    <div className="grid gap-4 md:grid-cols-2">
                      <RangeConfig
                        label="Volume"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={activeDraft.config.ttsVolume}
                        startLabel="轻一些"
                        endLabel="更响亮"
                        displayValue={activeDraft.config.ttsVolume.toFixed(1)}
                        onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { ttsVolume: value })}
                      />
                      <RangeConfig
                        label="Pitch"
                        min={-12}
                        max={12}
                        step={1}
                        value={activeDraft.config.ttsPitch}
                        startLabel="更低"
                        endLabel="更高"
                        displayValue={activeDraft.config.ttsPitch > 0 ? `+${activeDraft.config.ttsPitch}` : `${activeDraft.config.ttsPitch}`}
                        onChange={(value) => updatePodcastDraftConfig(activeDraft.id, { ttsPitch: value })}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>

          <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">Script Workspace</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">先在这里选好口播稿风格，再点击生成。</div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                  Agent · {generationAgentLabel}
                </div>
                {generationSession && (
                  <div className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                    Linked session · {generationSession.title}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => void handleGenerateScript()}
                  disabled={activeDraft.scriptStatus === 'generating' || transcriptLoading}
                  className="inline-flex items-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {activeDraft.scriptStatus === 'generating' || transcriptLoading ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                  生成口播稿
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerateAudio()}
                  disabled={activeDraft.audioStatus === 'generating' || activeDraft.scriptStatus === 'generating'}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {activeDraft.audioStatus === 'generating' ? (
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mic className="h-4 w-4" />
                  )}
                  生成音频
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyScript()}
                  className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <Copy className="h-4 w-4" />
                  复制稿件
                </button>
              </div>
            </div>

            <div className="mt-4 rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">口播稿风格</div>
              <div className="mt-2 text-sm text-[var(--text-secondary)]">这里的选项会直接影响生成出来的文案风格。</div>
              <div className="mt-3 flex flex-wrap gap-2">
                {STYLE_OPTIONS.map((option) => {
                  const active = activeDraft.config.style === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => updatePodcastDraftConfig(activeDraft.id, { style: option.value })}
                      className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                        active
                          ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                          : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {!projectCwd && (
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
                <div>Select a project folder first so the script job has a workspace.</div>
                <button
                  type="button"
                  onClick={() => void handleSelectProjectFolder()}
                  className="inline-flex items-center gap-2 rounded-xl border border-amber-300/40 bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                  <FolderOpen className="h-4 w-4" />
                  Choose folder
                </button>
              </div>
            )}

            {activeDraft.scriptError && (
              <div className="mt-4 rounded-2xl border border-red-300/50 bg-red-500/8 px-4 py-3 text-sm text-red-200">
                {activeDraft.scriptError}
              </div>
            )}

            <textarea
              value={activeDraft.script}
              onChange={(event) => setPodcastScriptContent(activeDraft.id, event.target.value)}
              placeholder="Your generated podcast script will appear here."
              className="mt-4 min-h-[320px] w-full rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-4 text-sm leading-7 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </section>

          <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">Audio Workspace</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">用 MiniMax 把双人口播稿合成为最终音频。</div>
              </div>

              <div className="rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                {formatAudioStatus(activeDraft.audioStatus)}
              </div>
            </div>

            <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_320px]">
              <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">Voice pairing</div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">
                  主持人A 使用 {formatMiniMaxVoiceLabel(activeDraft.config.ttsVoice)}，主持人B 使用 {formatMiniMaxVoiceLabel(activeDraft.config.ttsHostBVoice)}。
                </div>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <ReadOnlyConfig label="Model" value={MINIMAX_MODEL} />
                  <ReadOnlyConfig label="Speed" value={`${activeDraft.config.ttsSpeed.toFixed(2)}x`} />
                  <ReadOnlyConfig label="Pitch / Volume" value={`${activeDraft.config.ttsPitch > 0 ? `+${activeDraft.config.ttsPitch}` : activeDraft.config.ttsPitch} / ${activeDraft.config.ttsVolume.toFixed(1)}`} />
                </div>

                {activeDraft.audioError && (
                  <div className="mt-4 rounded-2xl border border-red-300/50 bg-red-500/8 px-4 py-3 text-sm text-red-200">
                    {activeDraft.audioError}
                  </div>
                )}

                {activeDraft.audioOutputPath ? (
                  <div className="mt-4 space-y-3">
                    <audio controls src={toFileUrl(activeDraft.audioOutputPath)} className="w-full" />
                    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)] break-all">
                      {activeDraft.audioOutputPath}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-8 text-sm text-[var(--text-secondary)]">
                    生成完成后，音频播放器和文件路径会显示在这里。
                  </div>
                )}
              </div>

              <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
                <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">Actions</div>
                <div className="mt-2 text-sm text-[var(--text-secondary)]">先确认 API Key 与音色，然后一键生成最终播客音频。</div>
                <div className="mt-4 space-y-3">
                  <button
                    type="button"
                    onClick={() => void handleGenerateAudio()}
                    disabled={activeDraft.audioStatus === 'generating' || !activeDraft.script.trim()}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {activeDraft.audioStatus === 'generating' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Mic className="h-4 w-4" />}
                    生成最终音频
                  </button>
                  <button
                    type="button"
                    onClick={() => activeDraft.audioOutputPath && void window.electron.openPath(activeDraft.audioOutputPath)}
                    disabled={!activeDraft.audioOutputPath}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <FolderOpen className="h-4 w-4" />
                    打开音频文件
                  </button>
                  <button
                    type="button"
                    onClick={() => activeDraft.audioOutputPath && void window.electron.revealPath(activeDraft.audioOutputPath)}
                    disabled={!activeDraft.audioOutputPath}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <FolderOpen className="h-4 w-4" />
                    在 Finder 中显示
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-[24px] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-lg font-semibold text-[var(--text-primary)]">Generation Pipeline</div>
                <div className="mt-1 text-sm text-[var(--text-secondary)]">当前工作流已经覆盖素材接入、双人口播稿生成，以及 MiniMax 最终音频合成。</div>
              </div>

              <div className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-xs text-[var(--text-secondary)]">
                <Mic className="h-3.5 w-3.5" />
                Podcast pipeline active
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-3">
              <PipelineCard
                title="Source ingestion"
                description="YouTube、网页和文件素材统一汇总到同一个播客草稿中。"
                status={`${activeDraft.sources.length} 个素材`}
              />
              <PipelineCard
                title="Script planning"
                description="双主持人口播稿会根据节奏、风格、语气和时长设置自动生成。"
                status={`${formatScriptStatus(activeDraft.scriptStatus)} · 双人 · ${formatPodcastStyleLabel(activeDraft.config.style)}`}
              />
              <PipelineCard
                title="Audio output"
                description="MiniMax 异步 TTS 会按 Host A / Host B 的音色配置拼接最终 MP3。"
                status={`${formatAudioStatus(activeDraft.audioStatus)} · ${formatMiniMaxVoiceLabel(activeDraft.config.ttsVoice)} / ${formatMiniMaxVoiceLabel(activeDraft.config.ttsHostBVoice)}`}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function extractAssistantText(messages: import('../../types').StreamMessage[]): string {
  return messages
    .filter((message): message is Extract<import('../../types').StreamMessage, { type: 'assistant' }> => message.type === 'assistant')
    .flatMap((message) => getMessageContentBlocks(message))
    .filter((block): block is Extract<(typeof getMessageContentBlocks extends (...args: any[]) => infer R ? R[number] : never), { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

function buildPodcastScriptRequest(draft: PodcastDraftView, cwd: string, transcript: string) {
  const provider = loadPreferredProvider();
  const claudeModel = loadPreferredClaudeModel();
  const codexModel = loadPreferredCodexModel();
  const opencodeModel = loadPreferredOpencodeModel();
  const model =
    provider === 'claude' ? claudeModel || undefined : provider === 'codex' ? codexModel || undefined : opencodeModel || undefined;
  const compatibleProviderId = provider === 'claude' ? loadPreferredClaudeCompatibleProviderId() || undefined : undefined;
  const betas =
    provider === 'claude' && loadPreferredClaudeContext1m() && supportsClaude1mContext(model)
      ? ['context-1m-2025-08-07']
      : undefined;
  const codexPermissionMode = provider === 'codex' ? loadPreferredCodexPermissionMode() : undefined;

  return {
    title: `[Podcast] ${draft.title}`,
    prompt: buildPodcastScriptPrompt(draft, transcript),
    cwd,
    provider: provider as AgentProvider,
    model,
    compatibleProviderId,
    betas,
    codexPermissionMode,
  };
}

function buildPodcastScriptPrompt(draft: PodcastDraftView, transcript: string): string {
  const sourceLines = draft.sources.length > 0
    ? draft.sources.map((source, index) => `${index + 1}. [${source.kind}] ${source.title} — ${source.value}`).join('\n')
    : 'No explicit sources were attached.';
  const clippedTranscript = transcript.trim().slice(0, 60_000);
  const transcriptNote =
    transcript.trim().length > clippedTranscript.length
      ? '\n\n[Transcript was clipped to the first 60,000 characters for prompt size.]'
      : '';

  return [
    '你正在 Aegis Podcast Studio 中撰写一篇高质量播客口播稿。',
    '',
    '只返回最终口播稿正文，使用 Markdown。',
    '不要解释你的过程，也不要提及上下文不足。',
    '整篇内容必须使用简体中文。',
    '这是一个双人主播节目，只允许主持人A和主持人B两位角色。',
    '',
    '播客要求：',
    '- 结构：主持人A与主持人B对话。',
    `- 目标时长：${draft.config.duration}`,
    `- 节奏：${draft.config.pacing}`,
    `- 风格：${formatPodcastStyleLabel(draft.config.style)}`,
    `- 语气：${draft.config.tone}`,
    `- 声线倾向：${draft.config.voice}`,
    '',
    '输出格式要求：',
    '- 先给一个简短标题。',
    '- 然后给出完整口播稿。',
    '- 始终明确使用“主持人A：”和“主持人B：”。',
    '- 主持人A负责主线推进与解释；主持人B负责提问、回应、承接和补充。',
    '- 开场先写一个 20 到 40 秒的强钩子。',
    '- 正文拆成 3 到 5 个自然段落或小节，并且衔接顺滑。',
    '- 结尾要有总结、观点回收或行动建议。',
    '- 语言要自然口语化，适合播客，不要写成书面文章。',
    '- 句子要适合 TTS 朗读，避免过长独白和难读表达。',
    ...getPodcastStyleGuidance(draft.config.style),
    '',
    '来源：',
    sourceLines,
    '',
    transcript.trim()
      ? `Transcript / source text:\n${clippedTranscript}${transcriptNote}`
      : 'Transcript / source text: [No transcript provided. Use the listed sources only.]',
  ].join('\n');
}

function formatScriptStatus(status: PodcastDraftView['scriptStatus']): string {
  switch (status) {
    case 'generating':
      return '生成中';
    case 'ready':
      return '口播稿已就绪';
    case 'error':
      return '需要处理';
    case 'idle':
    default:
      return '草稿';
  }
}

function formatAudioStatus(status: PodcastDraftView['audioStatus']): string {
  switch (status) {
    case 'generating':
      return '音频生成中';
    case 'ready':
      return '音频已就绪';
    case 'error':
      return '音频生成失败';
    case 'idle':
    default:
      return '待生成';
  }
}

function formatMiniMaxVoiceLabel(voiceId: string): string {
  return MINIMAX_VOICE_OPTIONS.find((option) => option.value === voiceId)?.label || voiceId;
}

function toFileUrl(filePath: string): string {
  return encodeURI(`file://${filePath}`).replace(/#/g, '%23');
}

function formatPodcastStyleLabel(style: PodcastStyle): string {
  switch (style) {
    case 'deep_dive':
      return '深度拆解';
    case 'news_brief':
      return '新闻快评';
    case 'storytelling':
      return '故事化讲述';
    case 'debate':
      return '辩论式';
    case 'xiangsheng':
      return '相声式';
    case 'conversational':
    default:
      return '轻松对谈';
  }
}

function getPodcastStyleGuidance(style: PodcastStyle): string[] {
  switch (style) {
    case 'debate':
      return [
        '- 风格细则：整体要有“观点交锋”的感觉，但仍然保持信息密度和播客可听性。',
        '- 主持人A与主持人B要有明确立场差异，围绕同一主题提出不同判断、反驳和让步。',
        '- 不能变成吵架，要像高质量辩论型播客。',
      ];
    case 'xiangsheng':
      return [
        '- 风格细则：整体采用中文双人相声式节奏，强调捧哏与逗哏的来回配合。',
        '- 用包袱、接话、反问、误会再澄清等方式增强趣味，但不要低俗，也不要直接模仿现实团体或现成作品。',
        '- 仍要保证信息内容清楚，不能只剩玩笑。',
      ];
    case 'deep_dive':
      return ['- 风格细则：重分析、重背景、重逻辑层层展开。'];
    case 'news_brief':
      return ['- 风格细则：节奏更快，重点结论靠前，适合新闻快评。'];
    case 'storytelling':
      return ['- 风格细则：强调叙事感、转场感和故事推进。'];
    case 'conversational':
    default:
      return ['- 风格细则：自然、轻松、亲切，像两位主播在认真聊天。'];
  }
}

function getPreferredGenerationAgentLabel(): string {
  const provider = loadPreferredProvider();

  if (provider === 'claude') {
    const model = loadPreferredClaudeModel();
    return model ? `Claude · ${formatClaudeModelLabel(model, loadPreferredClaudeContext1m())}` : 'Claude';
  }

  if (provider === 'codex') {
    const model = loadPreferredCodexModel();
    return model ? `Codex · ${formatCodexModelLabel(model)}` : 'Codex';
  }

  const model = loadPreferredOpencodeModel();
  return model ? `OpenCode · ${formatOpencodeModelLabel(model)}` : 'OpenCode';
}

function ConfigSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReadOnlyConfig({ label, value }: { label: string; value: string }) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <div className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2.5 text-sm text-[var(--text-primary)]">
        {value}
      </div>
    </label>
  );
}

function RangeConfig({
  label,
  min,
  max,
  step,
  value,
  displayValue,
  startLabel,
  endLabel,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  displayValue: string;
  startLabel: string;
  endLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">{label}</div>
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-3">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full"
        />
        <div className="mt-2 flex items-center justify-between text-xs text-[var(--text-secondary)]">
          <span>{startLabel}</span>
          <span>{displayValue}</span>
          <span>{endLabel}</span>
        </div>
      </div>
    </label>
  );
}

function PipelineCard({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status: string;
}) {
  return (
    <div className="rounded-[20px] border border-[var(--border)] bg-[var(--bg-primary)] p-4">
      <div className="text-sm font-semibold text-[var(--text-primary)]">{title}</div>
      <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">{description}</div>
      <div className="mt-4 text-xs font-medium text-[var(--text-muted)]">{status}</div>
    </div>
  );
}
