export interface LiveWidgetSegment {
  type: 'widget';
  title: string;
  html: string;
  complete: boolean;
  key: string;
}

export interface MarkdownSegment {
  type: 'markdown';
  content: string;
  key: string;
}

export type StructuredSegment = MarkdownSegment | LiveWidgetSegment;

const WIDGET_OPEN_TAG = /<aegis-widget\b([^>]*)>/i;
const WIDGET_CLOSE_TAG = '</aegis-widget>';
const ATTR_PATTERN = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const DANGEROUS_TAGS = /<(iframe|object|embed|meta|link|base|form)[\s>][\s\S]*?<\/\1>/gi;
const DANGEROUS_VOID = /<(iframe|object|embed|meta|link|base)\b[^>]*\/?>/gi;

function getAttributeValue(rawAttributes: string, name: string): string | null {
  const normalizedName = name.toLowerCase();
  for (const match of rawAttributes.matchAll(ATTR_PATTERN)) {
    if ((match[1] || '').toLowerCase() !== normalizedName) {
      continue;
    }
    return (match[2] ?? match[3] ?? match[4] ?? '').trim() || null;
  }
  return null;
}

export function parseStructuredSegments(content: string): StructuredSegment[] {
  if (!content.trim()) {
    return [];
  }

  const segments: StructuredSegment[] = [];
  let cursor = 0;
  let widgetIndex = 0;

  while (cursor < content.length) {
    const remaining = content.slice(cursor);
    const openMatch = WIDGET_OPEN_TAG.exec(remaining);
    if (!openMatch || openMatch.index === undefined) {
      const tail = remaining;
      if (tail) {
        segments.push({
          type: 'markdown',
          content: tail,
          key: `markdown-${segments.length}`,
        });
      }
      break;
    }

    const openStart = cursor + openMatch.index;
    const openEnd = openStart + openMatch[0].length;
    const before = content.slice(cursor, openStart);
    if (before) {
      segments.push({
        type: 'markdown',
        content: before,
        key: `markdown-${segments.length}`,
      });
    }

    const closingIndex = content.indexOf(WIDGET_CLOSE_TAG, openEnd);
    const complete = closingIndex >= 0;
    const html = complete ? content.slice(openEnd, closingIndex) : content.slice(openEnd);
    const rawTitle = getAttributeValue(openMatch[1] || '', 'title');

    segments.push({
      type: 'widget',
      title: rawTitle || `Live Preview ${widgetIndex + 1}`,
      html: html.trim(),
      complete,
      key: `widget-${widgetIndex}`,
    });

    widgetIndex += 1;
    cursor = complete ? closingIndex + WIDGET_CLOSE_TAG.length : content.length;
  }

  return segments.filter((segment) => {
    if (segment.type === 'markdown') {
      return segment.content.length > 0;
    }
    return segment.html.length > 0 || !segment.complete;
  });
}

export function sanitizeWidgetPreviewHtml(html: string): string {
  return html
    .replace(DANGEROUS_TAGS, '')
    .replace(DANGEROUS_VOID, '')
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']*)/gi, '')
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(
      /\s+(href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']*))/gi,
      (match, _attr: string, dq?: string, sq?: string, uq?: string) => {
        const url = (dq ?? sq ?? uq ?? '').trim();
        if (/^\s*(javascript|data)\s*:/i.test(url)) {
          return '';
        }
        return match;
      }
    );
}

export function sanitizeWidgetFinalHtml(html: string): string {
  return html.replace(DANGEROUS_TAGS, '').replace(DANGEROUS_VOID, '');
}

function escapeScriptText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

export function buildWidgetReceiverSrcdoc(styleBlock: string): string {
  const receiverScript = escapeScriptText(`
    (function () {
      var widgetId = null;
      var root = document.getElementById('__aegis_widget_root');
      var resizeTimer = null;

      function post(type, payload) {
        parent.postMessage(Object.assign({ __aegisWidget: true, widgetId: widgetId, type: type }, payload || {}), '*');
      }

      function scheduleResize() {
        if (resizeTimer) {
          clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(function () {
          var height = Math.max(
            document.documentElement ? document.documentElement.scrollHeight : 0,
            document.body ? document.body.scrollHeight : 0,
            root ? root.scrollHeight : 0
          );
          post('resize', { height: height });
        }, 40);
      }

      function executeScripts(container) {
        var scripts = container.querySelectorAll('script');
        for (var i = 0; i < scripts.length; i += 1) {
          var script = scripts[i];
          var replacement = document.createElement('script');
          for (var j = 0; j < script.attributes.length; j += 1) {
            var attribute = script.attributes[j];
            replacement.setAttribute(attribute.name, attribute.value);
          }
          replacement.textContent = script.textContent || '';
          script.parentNode && script.parentNode.replaceChild(replacement, script);
        }
      }

      function applyHtml(html) {
        if (!root) return;
        root.innerHTML = html;
        scheduleResize();
      }

      function finalizeHtml(html) {
        if (!root) return;
        root.innerHTML = html;
        executeScripts(root);
        scheduleResize();
      }

      document.addEventListener('click', function (event) {
        var target = event.target;
        while (target && target.tagName !== 'A') {
          target = target.parentElement;
        }
        if (!target) {
          return;
        }
        var href = target.getAttribute('href');
        if (!href) {
          return;
        }
        event.preventDefault();
        post('open-link', { href: href });
      });

      var observer = new ResizeObserver(scheduleResize);
      observer.observe(document.body);

      window.addEventListener('message', function (event) {
        var data = event.data || {};
        if (!data.__aegisWidget) {
          return;
        }
        if (widgetId && data.widgetId !== widgetId) {
          return;
        }
        if (data.type === 'init') {
          widgetId = data.widgetId || widgetId;
          if (data.themeCss) {
            var theme = document.getElementById('__aegis_widget_theme');
            if (theme) {
              theme.textContent = data.themeCss;
            }
          }
          if (typeof data.html === 'string') {
            applyHtml(data.html);
          }
          post('ready');
          return;
        }
        if (data.type === 'theme' && data.themeCss) {
          var theme = document.getElementById('__aegis_widget_theme');
          if (theme) {
            theme.textContent = data.themeCss;
          }
          scheduleResize();
          return;
        }
        if (data.type === 'update' && typeof data.html === 'string') {
          applyHtml(data.html);
          return;
        }
        if (data.type === 'finalize' && typeof data.html === 'string') {
          finalizeHtml(data.html);
        }
      });
    })();
  `);

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<style id="__aegis_widget_theme"></style>',
    `<style>${styleBlock}</style>`,
    '</head>',
    '<body>',
    '<div id="__aegis_widget_root"></div>',
    `<script>${receiverScript}</script>`,
    '</body>',
    '</html>',
  ].join('');
}
