import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { MDContent } from '../render/markdown';
import {
  buildWidgetReceiverSrcdoc,
  parseStructuredSegments,
  sanitizeWidgetFinalHtml,
  sanitizeWidgetPreviewHtml,
  type StructuredSegment,
} from '../utils/live-widgets';

interface StructuredResponseProps {
  content: string;
  streaming?: boolean;
  className?: string;
}

const RECEIVER_BASE_STYLE = `
  :root {
    color-scheme: light dark;
  }
  html, body {
    margin: 0;
    padding: 0;
    min-height: 100%;
    background: transparent;
    color: inherit;
    font-family: inherit;
  }
  body {
    overflow-x: hidden;
  }
  #__aegis_widget_root {
    min-height: 1px;
  }
`;

function extractThemeCssVariables(): string {
  if (typeof window === 'undefined') {
    return ':root {} body { margin: 0; background: transparent; color: #e5e7eb; }';
  }

  const style = getComputedStyle(document.documentElement);
  const variableNames = [
    '--bg-primary',
    '--bg-secondary',
    '--bg-tertiary',
    '--text-primary',
    '--text-secondary',
    '--text-muted',
    '--border',
    '--accent',
    '--accent-light',
    '--preview-surface',
  ];

  const declarations = variableNames
    .map((name) => {
      const value = style.getPropertyValue(name).trim();
      return value ? `${name}: ${value};` : '';
    })
    .filter(Boolean)
    .join(' ');

  const fontFamily = style.getPropertyValue('font-family').trim();

  return [
    ':root {',
    declarations,
    fontFamily ? `font-family: ${fontFamily};` : '',
    '}',
    'body {',
    'margin: 0;',
    'background: transparent;',
    'color: var(--text-primary, #e5e7eb);',
    fontFamily ? `font-family: ${fontFamily};` : '',
    '}',
  ].join(' ');
}

function WidgetCard({
  title,
  html,
  complete,
  streaming,
}: {
  title: string;
  html: string;
  complete: boolean;
  streaming: boolean;
}) {
  const widgetId = useId();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(220);
  const deferredHtml = useDeferredValue(html);
  const themeCss = extractThemeCssVariables();
  const previewHtml = useMemo(() => sanitizeWidgetPreviewHtml(deferredHtml), [deferredHtml]);
  const finalHtml = useMemo(() => sanitizeWidgetFinalHtml(deferredHtml), [deferredHtml]);
  const srcDoc = useMemo(() => buildWidgetReceiverSrcdoc(RECEIVER_BASE_STYLE), []);
  const hasContent = deferredHtml.trim().length > 0;

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data as
        | { __aegisWidget?: boolean; widgetId?: string; type?: string; height?: number; href?: string }
        | undefined;
      if (!data?.__aegisWidget || data.widgetId !== widgetId) {
        return;
      }
      if (data.type === 'ready') {
        setReady(true);
        return;
      }
      if (data.type === 'resize' && typeof data.height === 'number') {
        setHeight(Math.max(140, Math.min(720, Math.round(data.height))));
        return;
      }
      if (data.type === 'open-link' && typeof data.href === 'string') {
        window.open(data.href, '_blank', 'noopener,noreferrer');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [widgetId]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame || !loaded) {
      return;
    }

    const mode: 'update' | 'finalize' = !streaming && complete ? 'finalize' : 'update';
    const payloadHtml = mode === 'finalize' ? finalHtml : previewHtml;
    const targetWindow = frame.contentWindow;
    if (!targetWindow) {
      return;
    }

    targetWindow.postMessage(
      {
        __aegisWidget: true,
        widgetId,
        type: ready ? mode : 'init',
        html: payloadHtml,
        themeCss,
      },
      '*'
    );
  }, [complete, finalHtml, loaded, previewHtml, ready, streaming, themeCss, widgetId]);

  useEffect(() => {
    if (!loaded || !ready || !iframeRef.current?.contentWindow) {
      return;
    }

    iframeRef.current.contentWindow.postMessage(
      {
        __aegisWidget: true,
        widgetId,
        type: 'theme',
        themeCss,
      },
      '*'
    );
  }, [loaded, ready, themeCss, widgetId]);

  if (!hasContent && streaming) {
    return (
      <div className="live-widget-shell">
        <div className="live-widget-header">
          <div className="live-widget-title">
            <Sparkles className="h-3.5 w-3.5" />
            <span>{title}</span>
          </div>
          <span className="live-widget-state">Streaming…</span>
        </div>
        <div className="live-widget-placeholder">Waiting for widget markup…</div>
      </div>
    );
  }

  return (
    <div className="live-widget-shell">
      <div className="live-widget-header">
        <div className="live-widget-title">
          <Sparkles className="h-3.5 w-3.5" />
          <span>{title}</span>
        </div>
        <span className="live-widget-state">
          {streaming || !complete ? 'Live Preview' : 'Rendered'}
        </span>
      </div>
      <iframe
        ref={iframeRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        onLoad={() => {
          setLoaded(true);
          setReady(false);
        }}
        className="live-widget-frame"
        style={{ height }}
      />
      <div className="live-widget-footer">
        <span>
          {streaming || !complete
            ? 'Scripts and inline handlers stay disabled until the response finishes.'
            : 'Finalized widget is running inside an isolated sandbox.'}
        </span>
        <span className="live-widget-footer-icon">
          <ExternalLink className="h-3 w-3" />
        </span>
      </div>
    </div>
  );
}

export function StructuredResponse({
  content,
  streaming = false,
  className = '',
}: StructuredResponseProps) {
  const deferredContent = useDeferredValue(content);
  const segments = useMemo(() => parseStructuredSegments(deferredContent), [deferredContent]);

  if (segments.length === 0) {
    return null;
  }

  const hasWidget = segments.some((segment) => segment.type === 'widget');
  if (!hasWidget) {
    return <MDContent content={deferredContent} className={className} />;
  }

  return (
    <div className={`structured-response ${className}`.trim()}>
      {segments.map((segment: StructuredSegment) => {
        if (segment.type === 'markdown') {
          if (!segment.content.trim()) {
            return null;
          }
          return <MDContent key={segment.key} content={segment.content} />;
        }

        return (
          <WidgetCard
            key={segment.key}
            title={segment.title}
            html={segment.html}
            complete={segment.complete}
            streaming={streaming}
          />
        );
      })}
    </div>
  );
}
