// 全局类型声明（Window 扩展）
// 实际类型定义在 src/shared/types.ts

import type {
  AegisBuiltInAgentConfig,
  ClientEvent,
  ClaudeCompatibleProvidersConfig,
  ServerEvent,
  StatisticsData,
  StaticData,
  Attachment,
  ChatSessionSearchResult,
  FontSettingsPayload,
  MemoryDocument,
  MemoryWorkspace,
  ProjectTreeNode,
  PromptLibraryExportResult,
  PromptLibraryImportResult,
  PromptLibraryItem,
  SystemFontOption,
  ClaudeModelConfig,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  UpsertPromptLibraryItemInput,
  CodexModelConfig,
  CodexRuntimeStatus,
  OpenCodeModelConfig,
  OpenCodeRuntimeStatus,
  ClaudeRuntimeStatus,
  UiResumeState,
  SkillMarketItem,
  SkillMarketDetail,
  SkillMarketInstallResult,
  FeishuBridgeConfig,
  FeishuBridgeStatus,
  AppUpdateStatus,
  ProviderComposerCapabilities,
  ProviderListPluginsInput,
  ProviderListPluginsResult,
  ProviderListSkillsInput,
  ProviderListSkillsResult,
  ProviderReadPluginInput,
  ProviderReadPluginResult,
} from './shared/types';
import type {
  BrowserCapturePageResult,
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserReadoutResult,
  BrowserSendSelectionEvent,
  BrowserSessionInput,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  SessionBrowserState,
} from './shared/browser-types';

declare global {
  interface ElectronAPI {
    onServerEvent: (callback: (event: ServerEvent) => void) => () => void;
    sendClientEvent: (event: ClientEvent) => void;
    onTerminalEvent: (callback: (event: { type: 'data' | 'exit'; sessionId: string; data?: string; exitCode?: number | null }) => void) => () => void;
    generateSessionTitle: (prompt: string) => Promise<string>;
    getRecentCwds: (limit?: number) => Promise<string[]>;
    startTerminalSession: (sessionId: string, cwd: string, cols?: number, rows?: number) => Promise<{ ok: boolean; history?: string; message?: string }>;
    writeTerminalSession: (sessionId: string, data: string) => Promise<{ ok: boolean; message?: string }>;
    resizeTerminalSession: (sessionId: string, cols: number, rows: number) => Promise<{ ok: boolean; message?: string }>;
    stopTerminalSession: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
    setWindowMinSize: (width: number, height: number) => Promise<{ ok: boolean }>;
    getAppVersion: () => Promise<string>;
    setTheme: (theme: 'light' | 'dark' | 'system') => Promise<{ ok: boolean }>;
    getUiResumeState: () => Promise<UiResumeState | null>;
    getUiResumeStateSync: () => UiResumeState | null;
    saveUiResumeState: (state: UiResumeState) => Promise<{ ok: boolean }>;
    loadOlderSessionHistory: (sessionId: string, cursor: string, limit?: number) => Promise<import('./shared/types').SessionHistoryPayload>;
    loadSessionHistoryAround: (
      sessionId: string,
      messageCreatedAt: number,
      before?: number,
      after?: number
    ) => Promise<import('./shared/types').SessionHistoryPayload>;
    checkForUpdates: () => Promise<{ ok: boolean }>;
    getUpdateStatus: () => Promise<AppUpdateStatus>;
    getClaudeModelConfig: () => Promise<ClaudeModelConfig>;
    getClaudeCompatibleProviderConfig: () => Promise<ClaudeCompatibleProvidersConfig>;
    saveClaudeCompatibleProviderConfig: (config: ClaudeCompatibleProvidersConfig) => Promise<ClaudeCompatibleProvidersConfig>;
    getAegisBuiltInAgentConfig: () => Promise<AegisBuiltInAgentConfig>;
    saveAegisBuiltInAgentConfig: (config: AegisBuiltInAgentConfig) => Promise<AegisBuiltInAgentConfig>;
    getClaudeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getCodexUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getOpencodeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getPromptLibrary: () => Promise<PromptLibraryItem[]>;
    savePromptLibraryItem: (input: UpsertPromptLibraryItemInput) => Promise<PromptLibraryItem[]>;
    deletePromptLibraryItem: (id: string) => Promise<PromptLibraryItem[]>;
    importPromptLibrary: () => Promise<PromptLibraryImportResult>;
    exportPromptLibrary: () => Promise<PromptLibraryExportResult>;
    searchChatMessages: (query: string, limit?: number) => Promise<ChatSessionSearchResult[]>;
    getCodexModelConfig: () => Promise<CodexModelConfig>;
    saveCodexModelVisibility: (enabledModels: string[]) => Promise<CodexModelConfig>;
    getCodexRuntimeStatus: () => Promise<CodexRuntimeStatus>;
    getCodexComposerCapabilities: () => Promise<ProviderComposerCapabilities>;
    listCodexSkills: (input: Omit<ProviderListSkillsInput, 'provider'>) => Promise<ProviderListSkillsResult>;
    listAegisSkills: (input: Omit<ProviderListSkillsInput, 'provider'>) => Promise<ProviderListSkillsResult>;
    listCodexPlugins: (input?: Omit<ProviderListPluginsInput, 'provider'>) => Promise<ProviderListPluginsResult>;
    readCodexPlugin: (input: Omit<ProviderReadPluginInput, 'provider'>) => Promise<ProviderReadPluginResult>;
    getOpencodeModelConfig: () => Promise<OpenCodeModelConfig>;
    saveOpencodeModelVisibility: (enabledModels: string[]) => Promise<OpenCodeModelConfig>;
    getOpencodeRuntimeStatus: () => Promise<OpenCodeRuntimeStatus>; 
    getClaudeRuntimeStatus: (model?: string | null) => Promise<ClaudeRuntimeStatus>;
    getSkillMarketHot: (limit?: number) => Promise<SkillMarketItem[]>;
    searchSkillMarket: (query: string, limit?: number) => Promise<SkillMarketItem[]>;
    getSkillMarketDetail: (id: string) => Promise<SkillMarketDetail>;
    installSkillFromMarket: (id: string) => Promise<SkillMarketInstallResult>;
    expandClaudeSkillPrompt: (skillFilePath: string, skillName: string, userPrompt: string) => Promise<{ ok: boolean; prompt?: string; message?: string }>;
    getFontSettings: () => Promise<FontSettingsPayload>;
    saveFontSelections: (selections: FontSettingsPayload['selections']) => Promise<FontSettingsPayload>;
    listSystemFonts: () => Promise<SystemFontOption[]>;
    importFontFile: () => Promise<FontSettingsPayload | null>;
    deleteImportedFont: (fontId: string) => Promise<FontSettingsPayload>;
    getFeishuBridgeConfig: () => Promise<FeishuBridgeConfig>;
    saveFeishuBridgeConfig: (config: FeishuBridgeConfig) => Promise<FeishuBridgeConfig>;
    getFeishuBridgeStatus: () => Promise<FeishuBridgeStatus>;
    getMemoryWorkspace: (projectCwd?: string | null) => Promise<MemoryWorkspace>;
    saveMemoryDocument: (filePath: string, content: string) => Promise<MemoryDocument>;
    startFeishuBridge: () => Promise<FeishuBridgeStatus>;
    stopFeishuBridge: () => Promise<FeishuBridgeStatus>;
    selectDirectory: () => Promise<string | null>;
    selectAttachments: () => Promise<Attachment[]>;
    readAttachmentPreview: (filePath: string) => Promise<string | null>;
    readProjectFilePreview: (cwd: string, filePath: string) => Promise<unknown>;
    createProjectAttachment: (cwd: string, filePath: string) => Promise<Attachment | null>;
    selectMarkdownImageAsset: (cwd: string, markdownFilePath: string) => Promise<{ ok: boolean; relativePath?: string; name?: string; message?: string } | null>;
    createInlineTextAttachment: (cwd: string, text: string) => Promise<Attachment | null>;
    createInlineImageAttachment: (mimeType: string, data: Uint8Array) => Promise<Attachment | null>;
    writeProjectTextFile: (cwd: string, filePath: string, content: string) => Promise<{ ok: boolean; message?: string }>;
    previewArtifactPath: (cwd: string, filePath: string, options?: { openInBrowser?: boolean }) => Promise<{ ok: boolean; url?: string; message?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    revealPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    getProjectTree: (cwd: string) => Promise<ProjectTreeNode | null>;
    watchProjectTree: (cwd: string) => Promise<boolean>;
    unwatchProjectTree: (cwd: string) => Promise<boolean>;
    getGitChanges: (cwd: string) => Promise<{ ok: boolean; error: string | null; entries: Array<{ filePath: string; status: string; staged: boolean }> }>;
    getGitWorkingTreeSummary: (cwd: string) => Promise<{ ok: boolean; error: string | null; insertions: number; deletions: number }>;
    getGitOverview: (cwd: string) => Promise<{
      ok: boolean;
      error: string | null;
      hasRepo: boolean;
      branch: string | null;
      upstream: string | null;
      hasUpstream: boolean;
      aheadCount: number;
      behindCount: number;
      hasOriginRemote: boolean;
      isGitHubRemote: boolean;
      isDefaultBranch: boolean;
      totalChanges: number;
      insertions: number;
      deletions: number;
      pr: { number: number; title: string; state: 'open' | 'closed' | 'merged'; url: string } | null;
    }>;
    getGitBranch: (cwd: string) => Promise<{ ok: boolean; branch: string | null; message?: string }>;
    getGitBranches: (cwd: string) => Promise<{
      ok: boolean;
      error: string | null;
      detachedHead: boolean;
      headShortHash: string | null;
      entries: Array<{
        name: string;
        fullRef: string;
        current: boolean;
        remote: boolean;
        upstream: string | null;
        shortHash: string;
      }>;
    }>;
    getGitHistory: (cwd: string) => Promise<{
      ok: boolean;
      error: string | null;
      entries: Array<{
        hash: string;
        shortHash: string;
        subject: string;
        authorName: string;
        authoredAt: string;
        relativeTime: string;
      }>;
    }>;
    getGitDiff: (cwd: string, filePath: string) => Promise<string>;
    gitStagePath: (cwd: string, filePath: string) => Promise<{ ok: boolean; message?: string }>;
    gitUnstagePath: (cwd: string, filePath: string) => Promise<{ ok: boolean; message?: string }>;
    gitDiscardPath: (cwd: string, filePath: string, status?: string) => Promise<{ ok: boolean; message?: string }>;
    gitCommit: (cwd: string, message: string) => Promise<{ ok: boolean; message?: string; output?: string }>;
    gitGenerateCommitMessage: (cwd: string) => Promise<{ ok: boolean; message?: string }>;
    gitPush: (cwd: string) => Promise<{ ok: boolean; message?: string; output?: string }>;
    gitSync: (cwd: string) => Promise<{ ok: boolean; message?: string; output?: string }>;
    gitCreatePr: (cwd: string) => Promise<{ ok: boolean; message?: string; url?: string }>;
    openExternalUrl: (url: string) => Promise<{ ok: boolean; message?: string }>;
    subscribeStatistics: (callback: (data: StatisticsData) => void) => () => void;
    getStaticData: () => Promise<StaticData>;
    browser: {
      open: (input: BrowserOpenInput) => Promise<SessionBrowserState>;
      close: (input: BrowserSessionInput) => Promise<SessionBrowserState>;
      hide: (input: BrowserSessionInput) => Promise<SessionBrowserState>;
      getState: (input: BrowserSessionInput) => Promise<SessionBrowserState>;
      setPanelBounds: (input: BrowserSetPanelBoundsInput) => Promise<SessionBrowserState>;
      navigate: (input: BrowserNavigateInput) => Promise<SessionBrowserState>;
      reload: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      goBack: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      goForward: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      newTab: (input: BrowserNewTabInput) => Promise<SessionBrowserState>;
      closeTab: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      selectTab: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      openDevTools: (input: BrowserTabInput) => Promise<SessionBrowserState>;
      capture: (input: BrowserTabInput) => Promise<BrowserCapturePageResult>;
      readPage: (input: BrowserTabInput) => Promise<BrowserReadoutResult>;
      onState: (callback: (state: SessionBrowserState) => void) => () => void;
      onSendSelection: (callback: (event: BrowserSendSelectionEvent) => void) => () => void;
    };
  }

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
