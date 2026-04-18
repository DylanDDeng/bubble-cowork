// 浏览器面板共享类型（主进程 + 渲染进程通用）
// 设计参考 dpcode (Emanuele-web04/dpcode) 的 ThreadBrowserState，
// 并与本项目以 sessionId 为粒度的会话绑定。

export type BrowserTabStatus = 'live' | 'suspended';

export interface BrowserTabState {
  id: string;
  url: string;
  title: string;
  status: BrowserTabStatus;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastCommittedUrl: string | null;
  lastError: string | null;
}

export interface SessionBrowserState {
  sessionId: string;
  open: boolean;
  activeTabId: string | null;
  tabs: BrowserTabState[];
  lastError: string | null;
}

export interface BrowserPanelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ===== IPC 输入类型 =====

export interface BrowserSessionInput {
  sessionId: string;
}

export interface BrowserOpenInput extends BrowserSessionInput {
  initialUrl?: string;
}

export interface BrowserNavigateInput extends BrowserSessionInput {
  tabId?: string;
  url: string;
}

export interface BrowserTabInput extends BrowserSessionInput {
  tabId: string;
}

export interface BrowserNewTabInput extends BrowserSessionInput {
  url?: string;
  activate?: boolean;
}

export interface BrowserSetPanelBoundsInput extends BrowserSessionInput {
  bounds: BrowserPanelBounds | null;
}

// ===== 截图 / 正文读取 =====

export interface BrowserCapturePageResult {
  ok: boolean;
  message?: string;
  dataUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  base64?: string;
  pageUrl?: string;
  pageTitle?: string;
}

export interface BrowserReadoutLink {
  url: string;
  text: string;
}

export interface BrowserReadoutResult {
  ok: boolean;
  message?: string;
  url?: string;
  title?: string;
  text?: string;
  selection?: string;
  links?: BrowserReadoutLink[];
}

// Emitted from the main process when the user chooses "Send selection to chat"
// in the in-app browser's native context menu.
export interface BrowserSendSelectionEvent {
  sessionId: string;
  tabId: string;
  selectionText: string;
  pageUrl: string;
  pageTitle: string;
}
