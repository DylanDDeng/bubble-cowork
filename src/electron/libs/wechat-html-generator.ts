import { basename, dirname, isAbsolute } from 'path';
import {
  AEGIS_BUILT_IN_DEFAULT_MODEL,
  getAegisBuiltInProvider,
  resolveAegisBuiltInModel,
} from '../../shared/aegis-built-in-catalog';
import type {
  AgentProvider,
  WechatMarkdownHtmlGenerationInput,
  WechatMarkdownHtmlGenerationResult,
  WechatMarkdownHtmlThemeId,
} from '../../shared/types';
import { loadAegisBuiltInAgentConfig } from './aegis-built-in-config';
import { runCodexOneShot, runOpenCodeOneShot } from './codex-runner';
import { runClaudeOneShot } from './util';
import { loadWechatHtmlGeneratorConfig } from './wechat-html-generator-config';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ModelSelection = {
  providerId: string;
  modelId: string;
  encodedModel: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxOutputTokens?: number;
};

type RuntimeSelection =
  | ({ runtime: 'aegis' } & ModelSelection)
  | {
      runtime: Exclude<AgentProvider, 'aegis'>;
      providerId: Exclude<AgentProvider, 'aegis'>;
      model?: string;
      encodedModel: string;
    };

type OpenAiContentPart = {
  text?: string;
  type?: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | OpenAiContentPart[] | null;
    };
    text?: string | null;
  }>;
  error?: {
    message?: string;
  };
};

const WECHAT_STYLE_MARKER =
  '<p style="display: none;"><mp-style-type data-value="3"></mp-style-type></p>';

const REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const DEFAULT_MODEL = AEGIS_BUILT_IN_DEFAULT_MODEL;

const MOONSHOT_PROVIDER_IDS = new Set(['moonshot-cn', 'moonshot-intl', 'kimi-for-coding']);
const KIMI_K25_FAMILY = new Set(['kimi-k2.5', 'k2.6-code-preview', 'kimi-k2.6']);
const KIMI_THINKING_FAMILY = new Set(['kimi-k2-thinking', 'kimi-k2-thinking-turbo']);
const KIMI_K26_DEFAULT_MAX_TOKENS = 32_768;

const PROVIDER_API_KEY_ENV: Record<string, string[]> = {
  openai: ['AEGIS_BUILTIN_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  zhipuai: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'],
  'zhipuai-coding-plan': ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-plan': ['ZAI_API_KEY'],
  'moonshot-cn': ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  'moonshot-intl': ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  'kimi-for-coding': ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
};

const PROVIDER_BASE_URL_ENV: Record<string, string[]> = {
  openai: ['AEGIS_BUILTIN_OPENAI_BASE_URL', 'OPENAI_BASE_URL'],
  deepseek: ['DEEPSEEK_BASE_URL'],
  google: ['GOOGLE_BASE_URL', 'GEMINI_BASE_URL'],
  zhipuai: ['ZHIPUAI_BASE_URL', 'ZHIPU_BASE_URL'],
  'zhipuai-coding-plan': ['ZHIPUAI_BASE_URL', 'ZHIPU_BASE_URL'],
  zai: ['ZAI_BASE_URL'],
  'zai-coding-plan': ['ZAI_BASE_URL'],
  'moonshot-cn': ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
  'moonshot-intl': ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
  'kimi-for-coding': ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
  groq: ['GROQ_BASE_URL'],
  together: ['TOGETHER_BASE_URL'],
  fireworks: ['FIREWORKS_BASE_URL'],
  local: ['LOCAL_OPENAI_BASE_URL', 'OLLAMA_BASE_URL'],
};

const BLACK_RED_IMPRINT_SYSTEM_PROMPT = `# 角色
你是一位兼具品牌视觉意识与出版级版式判断的公众号排版设计师，擅长把文章排成「黑红刊刻风」：冷静、锋利、有秩序，但依然耐读。

# 风格目标
- 主色为黑色 + 深红色 + 骨白底，不做俗气的大红大黑。
- 设计感来自结构线、留白、比例、编号与重点的克制使用，而不是装饰堆砌。
- 整体气质参考独立杂志内页、品牌手册、策展型版面，而不是传统公众号模板。
- 要有想法、有锋芒，但正文阅读舒适度优先。

# 色彩
- 页面主背景：#fbfaf8 或同类浅暖白。
- 正文主色：#181818 / #202020。
- 正文段落文字：#222222。
- 强调主色：#8f1d22 / #b3262d。
- 辅助灰：#6b7280 / #7a6a6c。
- 禁止高饱和纯红大面积铺底，禁止夜店风、赛博风、重金属海报风。

# 输出与技术硬性要求
1. 只输出可直接粘贴到公众号后台的 HTML 片段，不要解释，不要 Markdown 代码块。
2. 最外层使用一个 <section>，不要输出 <!doctype>、<html>、<head>、<body>。
3. 所有 CSS 必须写在元素的 inline style 中，严禁 <style> 标签、class、script。
4. 不要输出文章标题、刊头、封面标题区块；正文直接从正文内容开始。H1 只用于理解语境。
5. 不要生成公众号关注名片、二维码区、作者卡、封面 HTML。
6. 文末必须包含：<p style="display: none;"><mp-style-type data-value="3"></mp-style-type></p>
7. 保持原文语义、句子内容、段落顺序，不得扩写、删减或改写原文观点。

# 基础容器
使用以下结构作为最外层容器：
<section style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:#fbfaf8;color:#181818;max-width:700px;margin:0 auto;padding:22px 20px;font-size:14px;line-height:1.85;">
  <!-- 内容区域 -->
</section>

# 字号规范
- 正文：14px，颜色 #222222，line-height 1.85，letter-spacing 1px。
- 普通正文段落：margin 16px 0。
- H2：18px，font-weight 700，颜色 #111111。
- H3：16px，font-weight 700，颜色 #1f1f1f。
- 代码块文字：14px，必须与正文同字号。
- 图注、标签、编号：12-13px。
- 正文字间距 1px 只用于连续文本；标题、标签、代码区不要强行套用同样字距。

# 章节系统
H2 使用“深红章节签 + 黑色结构线”：
<div style="margin:42px 0 22px;">
  <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
    <span style="display:inline-block;padding:2px 8px;background:#8f1d22;color:#fff6f4;font-size:12px;line-height:1.4;letter-spacing:1px;font-weight:700;text-transform:uppercase;">Section 01</span>
    <span style="font-size:18px;line-height:1.4;font-weight:700;color:#111111;">章节标题</span>
  </div>
  <div style="width:48%;height:2px;background:linear-gradient(90deg,#111111 0%,#8f1d22 62%,rgba(143,29,34,0.12) 100%);"></div>
</div>
规则：每个主章节 Section 01 / 02 / 03 递增；红色标签小而利落，不做肥厚胶囊；结构线半截，40%-55% 宽度，不拉满。

# 常用元素规范
- 正文段落：<p style="margin:16px 0;color:#222222;font-size:14px;line-height:1.85;letter-spacing:1px;">正文内容</p>
- 图片：使用 <figure style="margin:24px 0;">，图片 width:100%; display:block; border-radius:6px; border:1px solid #d9d0d1; 图注左对齐，13px，#6a4b4d。
- 引文：margin:24px 0; padding:8px 0 8px 16px; border-left:3px solid #111111; 引文文字 14px / line-height 1.9。
- 链接：近黑文字 + 深红下划线，style="color:#1f1f1f;text-decoration:none;border-bottom:1.5px solid #b3262d;padding-bottom:1px;font-weight:600;"。
- 斜体：#5f5355，italic，不叠加高亮。
- 粗体：#1f1f1f，font-weight 700，不自动变红、不自动加底色。
- 核心概念：深红实线下划线。
- 关键句：浅红底条 #f7e4e5。
- 转折/警示：浅黄底条 #fff1bf。
- 操作项/方法名：深红文字 #8f1d22，font-weight 700。
- 每段强调不超过 2 处，宁缺毋滥。

# 代码区
代码块必须使用“VS Code 深色编辑器 + mac traffic light 顶栏”：
<div style="margin:22px 0;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#1e1e1e;box-shadow:0 10px 22px rgba(17,17,17,0.10);">
  <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:#252526;border-bottom:1px solid #343434;">
    <div style="display:flex;align-items:center;gap:7px;">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ff5f57;"></span>
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#ffbd2e;"></span>
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#28c840;"></span>
    </div>
    <span style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:12px;line-height:1.3;color:#c8c8c8;text-transform:uppercase;letter-spacing:0.6px;">LANG</span>
  </div>
  <pre style="margin:0;padding:14px 16px;background:#1e1e1e;overflow-x:auto;"><code style="font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:14px;line-height:1.8;color:#d4d4d4;white-space:pre;">code</code></pre>
</div>
规则：
- 代码块整体必须像 VS Code 编辑器窗口，不要再用纸白代码区。
- 顶栏左侧必须有 mac traffic light 三颗圆点，右侧显示语言名或 CODE。
- 代码正文区域使用 #1e1e1e 深色背景、#d4d4d4 主文本色，保留原始换行与缩进，支持横向滚动。
- 若能可靠判断语法，可以少量使用 VS Code 风格内联颜色（例如关键字 #569cd6、字符串 #ce9178、注释 #6a9955），但不要为了高亮破坏原始代码内容。

# 特殊组件
- tip/note 类内容可以渲染为：margin:24px 0; padding:14px 16px; background:#fff7f7; border:1px solid #ead9db; border-left:4px solid #8f1d22。
- 文末收束可以使用 End Note 标签 + 一句收束话 + 一行副小字，但不要添加关注卡或二维码。
- 原文空行用 12-14px 的可见垂直节奏，例如 <p style="margin:0;height:14px;line-height:14px;">&nbsp;</p>。

# 设计禁忌
- 禁止大面积纯黑背景块压住正文。
- 禁止每个段落都加边框或装饰。
- 禁止无意义高亮、满篇红字、促销风 CTA。
- 禁止正文、代码块字号偏离：正文必须 14px，代码块必须 14px，H2 必须 18px。`;

const BLACK_ORANGE_IMPRINT_SYSTEM_PROMPT = BLACK_RED_IMPRINT_SYSTEM_PROMPT
  .replace(/黑红刊刻风/g, '黑橙刊刻风')
  .replace('黑色 + 深红色 + 骨白底', '黑色 + 暖橙色 #ff7401 + 骨白底')
  .replace('#8f1d22 / #b3262d', '#ff7401 / #ff8e1a')
  .replace('禁止高饱和纯红大面积铺底', '禁止高饱和纯红或橙色大面积铺底')
  .replace('深红章节签', '暖橙章节签')
  .replace('background:#8f1d22;color:#fff6f4', 'background:#ff7401;color:#fff5ea')
  .replace(
    '#111111 0%,#8f1d22 62%,rgba(143,29,34,0.12)',
    '#111111 0%,#ff7401 62%,rgba(255,116,1,0.14)'
  )
  .replace('红色标签小而利落', '暖橙标签小而利落')
  .replace('深红下划线', '暖橙下划线')
  .replace('border-bottom:1.5px solid #b3262d', 'border-bottom:1.5px solid #ff7401')
  .replace('深红实线下划线', '暖橙实线下划线')
  .replace('浅红底条 #f7e4e5', '浅暖橙底条 #fff3e6')
  .replace('深红文字 #8f1d22', '暖橙文字 #ff7401')
  .replace(
    'background:#fff7f7; border:1px solid #ead9db; border-left:4px solid #8f1d22',
    'background:#fff7f0; border:1px solid #f1dcc9; border-left:4px solid #ff7401'
  )
  .replace('满篇红字', '满篇橙字');

function getWechatHtmlThemeName(themeId: WechatMarkdownHtmlThemeId): string {
  return themeId === 'black-orange-imprint' ? '黑橙刊刻风' : '黑红刊刻风';
}

function getWechatHtmlSystemPrompt(themeId: WechatMarkdownHtmlThemeId): string {
  return themeId === 'black-orange-imprint'
    ? BLACK_ORANGE_IMPRINT_SYSTEM_PROMPT
    : BLACK_RED_IMPRINT_SYSTEM_PROMPT;
}

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function getBuiltinBaseUrl(providerId: string): string {
  const config = loadAegisBuiltInAgentConfig();
  const provider = getAegisBuiltInProvider(providerId);
  const envBaseUrl = readFirstEnv([
    ...(PROVIDER_BASE_URL_ENV[providerId] || []),
    'AEGIS_BUILTIN_BASE_URL',
  ]);
  return (envBaseUrl || provider?.baseUrl || config.baseUrl || 'https://api.openai.com/v1')
    .trim()
    .replace(/\/+$/, '');
}

function getBuiltinApiKey(providerId: string): string {
  const config = loadAegisBuiltInAgentConfig();
  const envKey = readFirstEnv([
    ...(PROVIDER_API_KEY_ENV[providerId] || []),
    'AEGIS_BUILTIN_API_KEY',
  ]);
  const storedKey = config.providerApiKeys?.[providerId]
    || (config.providerId === providerId ? config.apiKey : '');
  return (storedKey || envKey).trim();
}

function normalizeGeneratorRuntime(value?: string | null): AgentProvider | null {
  switch ((value || '').trim().toLowerCase()) {
    case 'aegis':
    case 'claude':
    case 'codex':
    case 'opencode':
      return value!.trim().toLowerCase() as AgentProvider;
    default:
      return null;
  }
}

function resolveAegisSelection(modelOverride?: string): ModelSelection {
  const aegisConfig = loadAegisBuiltInAgentConfig();
  const selection = resolveAegisBuiltInModel(
    modelOverride?.trim()
      || process.env.AEGIS_BUILTIN_MODEL?.trim()
      || aegisConfig.model?.trim()
      || process.env.OPENAI_MODEL?.trim()
      || DEFAULT_MODEL,
    aegisConfig.providerId
  );
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    encodedModel: selection.encoded,
    baseUrl: getBuiltinBaseUrl(selection.providerId),
    apiKey: getBuiltinApiKey(selection.providerId),
    temperature: aegisConfig.temperature,
    maxOutputTokens: aegisConfig.maxOutputTokens,
  };
}

function resolveSelection(): RuntimeSelection {
  const wechatConfig = loadWechatHtmlGeneratorConfig();
  const explicitRuntime = normalizeGeneratorRuntime(process.env.AEGIS_WECHAT_HTML_RUNTIME);
  const explicitWechatModel = process.env.AEGIS_WECHAT_HTML_MODEL?.trim();

  const runtime = explicitRuntime || wechatConfig.runtime || 'aegis';
  if (runtime === 'aegis') {
    return { runtime, ...resolveAegisSelection(explicitWechatModel || undefined) };
  }

  const model = explicitWechatModel || wechatConfig.model?.trim() || '';
  return {
    runtime,
    providerId: runtime,
    model: model || undefined,
    encodedModel: model || `${runtime}:default`,
  };
}

function isFireworksKimi(providerId: string, modelId: string): boolean {
  const model = modelId.toLowerCase();
  return providerId === 'fireworks' && (
    model.includes('kimi') ||
    model.includes('k2p6') ||
    model === 'k2.6'
  );
}

function buildProviderRequestExtras(selection: ModelSelection): {
  extraBody?: Record<string, unknown>;
  omitTemperature?: boolean;
  maxTokens?: number;
} {
  if (isFireworksKimi(selection.providerId, selection.modelId)) {
    return { maxTokens: KIMI_K26_DEFAULT_MAX_TOKENS };
  }
  if (
    selection.providerId === 'deepseek' &&
    (selection.modelId === 'deepseek-v4-flash' || selection.modelId === 'deepseek-v4-pro')
  ) {
    return {
      extraBody: {
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      },
    };
  }
  if (MOONSHOT_PROVIDER_IDS.has(selection.providerId)) {
    if (KIMI_K25_FAMILY.has(selection.modelId)) {
      return {
        omitTemperature: true,
        extraBody: { thinking: { type: 'disabled' } },
      };
    }
    if (KIMI_THINKING_FAMILY.has(selection.modelId)) {
      return { omitTemperature: true };
    }
  }
  return {};
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function stripFrontmatter(markdown: string): string {
  const normalized = normalizeLineEndings(markdown);
  const lines = normalized.split('\n');
  if (!/^\s*---\s*$/.test(lines[0] || '')) return normalized;
  let end = 1;
  while (end < lines.length && !/^\s*---\s*$/.test(lines[end] || '')) {
    end += 1;
  }
  if (end >= lines.length) return normalized;
  return lines.slice(end + 1).join('\n').replace(/^\n+/, '');
}

function extractFirstHeading(markdown: string): string | null {
  const lines = normalizeLineEndings(markdown).split('\n');
  for (const line of lines) {
    const match = /^\s*#\s+(.+?)\s*$/.exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function deriveTitleFromFilePath(filePath?: string): string {
  if (!filePath) return '';
  return basename(filePath).replace(/\.[^.]+$/, '').trim();
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function stripLeadingTitleHeading(markdown: string, title: string): string {
  if (!title.trim()) return markdown;
  const lines = normalizeLineEndings(markdown).split('\n');
  let firstContentLine = 0;
  while (firstContentLine < lines.length && (lines[firstContentLine] || '').trim() === '') {
    firstContentLine += 1;
  }
  const headingMatch = /^\s*#\s+(.+?)\s*$/.exec(lines[firstContentLine] || '');
  if (!headingMatch?.[1]) return markdown;
  if (normalizeComparableText(headingMatch[1]) !== normalizeComparableText(title)) {
    return markdown;
  }
  const nextLines = [...lines.slice(0, firstContentLine), ...lines.slice(firstContentLine + 1)];
  if ((nextLines[firstContentLine] || '').trim() === '') {
    nextLines.splice(firstContentLine, 1);
  }
  return nextLines.join('\n');
}

function buildUserPrompt(input: WechatMarkdownHtmlGenerationInput): string {
  const markdownWithoutFrontmatter = stripFrontmatter(input.markdown);
  const title = extractFirstHeading(markdownWithoutFrontmatter) || deriveTitleFromFilePath(input.filePath);
  const markdownForPrompt = stripLeadingTitleHeading(markdownWithoutFrontmatter, title);
  const themeName = getWechatHtmlThemeName(input.themeId || 'black-red-imprint');
  const parts = [
    `请根据系统提示词中的「${themeName}」规范，排版以下 Markdown，并直接输出可粘贴到公众号后台的 HTML 片段。`,
    '',
    '输出要求：',
    '1. 只能输出 HTML，不要解释，不要 Markdown 代码块。',
    '2. 所有样式必须使用 inline style。',
    '3. 文末必须包含 <p style="display: none;"><mp-style-type data-value="3"></mp-style-type></p>。',
    '4. 不要输出文章标题、刊头、封面标题区块，正文直接从正文内容开始。',
    '5. 不要输出公众号关注名片、二维码区或主题封面 HTML。',
    '',
  ];
  if (title.trim()) {
    parts.push(`参考标题（仅理解语境，不要输出到 HTML）：${title}`);
    parts.push('');
  }
  parts.push('Markdown 内容：');
  parts.push('');
  parts.push(markdownForPrompt);
  return parts.join('\n');
}

function parseMessageContent(content: string | OpenAiContentPart[] | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:html)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return (match?.[1] || trimmed).trim();
}

function normalizeGeneratedHtml(rawHtml: string): string {
  let html = stripMarkdownFence(rawHtml);
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  if (bodyMatch?.[1]) {
    html = bodyMatch[1].trim();
  }
  html = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .trim();

  if (!html.includes('<mp-style-type data-value="3"></mp-style-type>')) {
    html = `${html}\n${WECHAT_STYLE_MARKER}`;
  }
  if (!html.trim()) {
    throw new Error('Model returned empty HTML.');
  }
  return html;
}

async function requestChatText(input: {
  messages: ChatMessage[];
  selection: ModelSelection;
}): Promise<string> {
  if (!input.selection.apiKey && input.selection.providerId !== 'local') {
    throw new Error('WeChat HTML generation requires an API key. Configure Settings > Aegis > WeChat HTML, or set a matching provider environment key.');
  }

  const extras = buildProviderRequestExtras(input.selection);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (input.selection.apiKey) {
    headers.Authorization = `Bearer ${input.selection.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: input.selection.modelId,
    messages: input.messages,
    stream: false,
    max_tokens: input.selection.maxOutputTokens || extras.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (!extras.omitTemperature) {
    body.temperature = input.selection.temperature;
  }
  if (extras.extraBody) {
    Object.assign(body, extras.extraBody);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${input.selection.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Model request failed with ${response.status}${detail ? `: ${detail.slice(0, 1200)}` : ''}`);
    }

    const parsed = await response.json() as ChatCompletionResponse;
    if (parsed.error?.message) {
      throw new Error(parsed.error.message);
    }
    const choice = parsed.choices?.[0];
    const text = parseMessageContent(choice?.message?.content) || (choice?.text || '').trim();
    if (!text) {
      throw new Error('Model returned empty content.');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function deriveWorkingDirectory(filePath?: string): string | undefined {
  if (!filePath || !isAbsolute(filePath)) return undefined;
  return dirname(filePath);
}

function buildAgentOneShotPrompt(input: WechatMarkdownHtmlGenerationInput): string {
  const systemPrompt = getWechatHtmlSystemPrompt(input.themeId || 'black-red-imprint');
  return [
    systemPrompt,
    '',
    '# 当前任务',
    buildUserPrompt(input),
    '',
    '再次强调：只能输出 HTML 片段本身，不要解释，不要使用工具，不要读写文件，不要包裹 Markdown 代码块。',
  ].join('\n');
}

async function requestAgentText(input: {
  promptInput: WechatMarkdownHtmlGenerationInput;
  selection: RuntimeSelection;
}): Promise<{ text: string; model?: string }> {
  const systemPrompt = getWechatHtmlSystemPrompt(input.promptInput.themeId || 'black-red-imprint');
  if (input.selection.runtime === 'aegis') {
    const text = await requestChatText({
      selection: input.selection,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildUserPrompt(input.promptInput) },
      ],
    });
    return { text, model: input.selection.encodedModel };
  }

  const prompt = buildAgentOneShotPrompt(input.promptInput);
  const cwd = deriveWorkingDirectory(input.promptInput.filePath);
  const model = input.selection.model || undefined;

  if (input.selection.runtime === 'claude') {
    const result = await runClaudeOneShot({
      prompt,
      cwd,
      model,
    });
    return { text: result.text, model: result.model || model };
  }

  if (input.selection.runtime === 'codex') {
    const result = await runCodexOneShot({
      prompt,
      cwd,
      model,
      codexPermissionMode: 'defaultPermissions',
    });
    return { text: result.text, model: result.model || model };
  }

  const result = await runOpenCodeOneShot({
    prompt,
    cwd,
    model,
    opencodePermissionMode: 'defaultPermissions',
  });
  return { text: result.text, model: result.model || model };
}

export async function generateWechatMarkdownHtml(
  input: WechatMarkdownHtmlGenerationInput,
): Promise<WechatMarkdownHtmlGenerationResult> {
  const themeId: WechatMarkdownHtmlThemeId = input.themeId || 'black-red-imprint';
  if (themeId !== 'black-red-imprint' && themeId !== 'black-orange-imprint') {
    throw new Error(`Unsupported WeChat HTML theme: ${themeId}`);
  }
  if (!input.markdown.trim()) {
    throw new Error('Markdown content is empty.');
  }

  const selection = resolveSelection();
  const generation = await requestAgentText({
    selection,
    promptInput: input,
  });

  return {
    html: normalizeGeneratedHtml(generation.text),
    model: generation.model || selection.encodedModel,
    providerId: selection.providerId,
    runtime: selection.runtime,
    themeId,
  };
}
