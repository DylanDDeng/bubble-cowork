import { useState } from 'react';
import * as Dialog from './ui/dialog';
import { Code2, Copy, X } from './icons';
import { parseToolOutput } from '../utils/tool-result-content';

export function ToolResultContent({ content, raw, pending = false, isError = false }: {
  content: string; raw: unknown; pending?: boolean; isError?: boolean;
}) {
  const [rawOpen, setRawOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const parts = parseToolOutput(content);
  const rawText = rawOpen ? JSON.stringify(raw, null, 2) : '';
  return (
    <div className={`group/tool-result relative min-w-0 space-y-1 ${isError ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>
      {parts.map((part, index) => {
        if (part.type === 'image') return <img key={index} src={part.src} alt="Image returned by tool" className="max-h-48 max-w-full rounded-md object-contain" />;
        if (part.type === 'audio') return <audio key={index} src={part.src} controls preload="metadata" className="w-full" />;
        if (part.type === 'resource') return (
          <div key={index} className="workstream-text space-y-1 break-words">
            <div>Read {part.name}</div>
            {part.uri !== part.name && <div>{part.uri}</div>}
            {part.mimeType && <div>{part.mimeType}</div>}
            {part.text && <ToolOutputPanel text={part.text} language="plaintext" />}
          </div>
        );
        return <ToolOutputPanel key={index} text={'text' in part ? part.text : ''} language={part.type === 'json' ? 'json' : 'plaintext'} isError={isError} />;
      })}
      {!parts.length && !pending && <p className="workstream-text">Tool returned no content</p>}
      <Dialog.Root open={rawOpen} onOpenChange={setRawOpen}>
        <Dialog.Trigger className="workstream-raw-trigger" aria-label="Show raw tool call output" title="Show raw tool call output">
          <Code2 className="h-3.5 w-3.5" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[200] bg-black/30" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-[201] flex max-h-[80vh] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-xl" aria-describedby={undefined}>
            <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
              <Dialog.Title className="flex-1 text-sm font-medium">Raw tool call output</Dialog.Title>
              <button type="button" aria-label={copied ? 'Copied' : 'Copy raw output'} title={copied ? 'Copied' : 'Copy raw output'} onClick={async () => {
                try { await navigator.clipboard.writeText(rawText); setCopied(true); } catch { setCopied(false); }
              }} className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"><Copy className="h-4 w-4" /></button>
              <Dialog.Close aria-label="Close raw output" className="rounded p-1.5 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"><X className="h-4 w-4" /></Dialog.Close>
            </div>
            <pre className="workstream-code workstream-raw-output overflow-auto whitespace-pre-wrap break-words p-4 text-[var(--text-secondary)]">{rawText}</pre>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export function ToolOutputPanel({ text, language, isError = false }: { text: string; language: string; isError?: boolean }) {
  return (
    <div className={`workstream-output-panel ${isError ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>
      <div className="workstream-output-heading">{language}</div>
      <pre className={language === 'plaintext' ? 'workstream-output-text' : 'workstream-code'}>{text.length > 120_000 ? `${text.slice(0, 120_000)}\n… Preview truncated; full content is available in raw output.` : text}</pre>
    </div>
  );
}
