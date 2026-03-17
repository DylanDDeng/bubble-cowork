import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import xml from 'highlight.js/lib/languages/xml';
import json from 'highlight.js/lib/languages/json';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import sql from 'highlight.js/lib/languages/sql';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';

hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('json', json);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('shell', shell);

/**
 * 从文件名推断语言
 */
function inferLanguage(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    json: 'json',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    css: 'css',
    scss: 'css',
    less: 'css',
    py: 'python',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    sql: 'sql',
    java: 'java',
    go: 'go',
    rs: 'rust',
  };
  return ext ? map[ext] : undefined;
}

interface HighlightedCodeProps {
  code: string;
  language?: string;
  fileName?: string;
  className?: string;
}

export function HighlightedCode({ code, language, fileName, className }: HighlightedCodeProps) {
  const { html, lines } = useMemo(() => {
    const lang = language || inferLanguage(fileName);
    let result: string;
    try {
      if (lang && hljs.getLanguage(lang)) {
        result = hljs.highlight(code, { language: lang }).value;
      } else {
        result = hljs.highlightAuto(code).value;
      }
    } catch {
      result = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    // 按行拆分，保留每行的 HTML（处理跨行 span 标签）
    const lineArray = splitHighlightedLines(result);
    return { html: result, lines: lineArray };
  }, [code, language, fileName]);

  const lineCount = lines.length;
  // 行号位数，至少 2 位
  const gutterWidth = Math.max(2, String(lineCount).length);

  return (
    <div className={`highlighted-code-block rounded-lg overflow-hidden ${className || ''}`}>
      <table className="highlighted-code-table">
        <tbody>
          {lines.map((lineHtml, i) => (
            <tr key={i} className="highlighted-code-line">
              <td
                className="highlighted-code-gutter"
                style={{ width: `${gutterWidth + 2}ch` }}
              >
                {i + 1}
              </td>
              <td className="highlighted-code-content">
                <span dangerouslySetInnerHTML={{ __html: lineHtml || '&nbsp;' }} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 将 highlight.js 的 HTML 输出按 \n 拆行，
 * 并确保跨行的 <span> 标签在每行正确闭合/重新打开
 */
function splitHighlightedLines(html: string): string[] {
  const raw = html.split('\n');
  const result: string[] = [];
  let openTags: string[] = [];

  for (const line of raw) {
    // 在行首重新打开之前未闭合的标签
    let prefix = openTags.join('');
    let content = prefix + line;

    // 追踪这一行中打开和关闭的 span 标签
    const openRegex = /<span[^>]*>/g;
    const closeRegex = /<\/span>/g;

    let opens = line.match(openRegex) || [];
    let closes = line.match(closeRegex) || [];

    // 更新 openTags 栈
    for (const tag of opens) {
      openTags.push(tag);
    }
    for (let j = 0; j < closes.length; j++) {
      openTags.pop();
    }

    // 在行尾闭合所有打开的标签
    let suffix = '</span>'.repeat(openTags.length);
    result.push(content + suffix);
  }

  return result;
}
