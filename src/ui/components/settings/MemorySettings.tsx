import { useEffect, useState } from 'react';
import { Brain, FolderOpen, RefreshCw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import type { MemoryDocument, MemoryWorkspace } from '../../types';

function formatUpdatedAt(updatedAt: number): string {
  try {
    return new Date(updatedAt).toLocaleString();
  } catch {
    return '';
  }
}

function MemoryDocumentEditor({
  document,
  onSave,
}: {
  document: MemoryDocument;
  onSave: (filePath: string, content: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(document.content);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(document.content);
  }, [document.content, document.path]);

  const dirty = draft !== document.content;

  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--text-primary)]">{document.title}</div>
          <div className="mt-1 text-[12px] leading-5 text-[var(--text-muted)]">{document.description}</div>
          <div className="mt-2 text-[11px] text-[var(--text-muted)]">{document.path}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            setSaving(true);
            void onSave(document.path, draft).finally(() => setSaving(false));
          }}
          disabled={!dirty || saving}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--accent-light)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
        >
          {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        className="mt-3 min-h-[220px] w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 font-mono text-[12px] leading-5 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
      />
      <div className="mt-2 text-[11px] text-[var(--text-muted)]">
        Last updated: {formatUpdatedAt(document.updatedAt)}
      </div>
    </section>
  );
}

export function MemorySettingsContent() {
  const { projectCwd } = useAppStore();
  const [workspace, setWorkspace] = useState<MemoryWorkspace | null>(null);
  const [loading, setLoading] = useState(true);

  const loadWorkspace = async () => {
    setLoading(true);
    try {
      const next = await window.electron.getMemoryWorkspace(projectCwd);
      setWorkspace(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load memory workspace.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadWorkspace();
  }, [projectCwd]);

  const handleSave = async (filePath: string, content: string) => {
    try {
      await window.electron.saveMemoryDocument(filePath, content);
      await loadWorkspace();
      toast.success('Memory document saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save memory document.');
    }
  };

  if (loading && !workspace) {
    return <div className="text-sm text-[var(--text-secondary)]">Loading memory workspace…</div>;
  }

  if (!workspace) {
    return <div className="text-sm text-[var(--text-secondary)]">Memory workspace unavailable.</div>;
  }

  return (
    <div className="space-y-8 pb-8">
      <section className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
              <Brain className="h-4 w-4" />
              Memory Workspace
            </div>
            <div className="mt-1 text-[13px] leading-6 text-[var(--text-muted)]">
              Reserved for Aegis Built-in Agent memory. Claude Code, Codex, and OpenCode keep their native memory and configuration behavior.
            </div>
            <div className="mt-3 text-[12px] text-[var(--text-muted)]">
              Root: {workspace.rootPath}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void loadWorkspace()}
            className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-primary)] px-3 text-[12px] font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </section>

      <section className="space-y-4">
        <div className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          Global Memory
        </div>
        <MemoryDocumentEditor document={workspace.assistantDocument} onSave={handleSave} />
        <MemoryDocumentEditor document={workspace.userDocument} onSave={handleSave} />
      </section>

      <section className="space-y-4">
        <div className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--text-muted)]">
          <FolderOpen className="h-3.5 w-3.5" />
          Project Memory
        </div>
        {workspace.projectDocument ? (
          <>
            <div className="text-[12px] text-[var(--text-muted)]">{workspace.projectCwd}</div>
            <MemoryDocumentEditor document={workspace.projectDocument} onSave={handleSave} />
          </>
        ) : (
          <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-[13px] text-[var(--text-muted)]">
            Select a project in the chat workspace to load the project memory file.
          </div>
        )}
      </section>
    </div>
  );
}
