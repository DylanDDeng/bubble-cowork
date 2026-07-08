// 全局类型声明（Window 扩展）
// 实际类型定义在 src/shared/types.ts

import type {
  AutomationDefinition,
  AutomationSnapshot,
  SessionInfo,
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
  CodexRateLimitReport,
  UpsertPromptLibraryItemInput,
  UpsertAutomationInput,
  CodexModelConfig,
  CodexRuntimeStatus,
  KimiModelConfig,
  GrokModelConfig,
  PiModelConfig,
  OpenCodeModelConfig,
  OpenCodeRuntimeStatus,
  KimiRuntimeStatus,
  GrokRuntimeStatus,
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
  WechatClipboardHtmlWriteInput,
  WechatClipboardHtmlWriteResult,
  WechatMarkdownHtmlGenerationInput,
  WechatMarkdownHtmlGenerationResult,
  WechatMarkdownHtmlGeneratorConfig,
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
import type {
  StartTerminalSessionResult,
  TerminalAgentKind,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEventPayload,
  TerminalOpenInput,
  TerminalOpenResult,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalTransportInfo,
  TerminalWriteInput,
} from './shared/terminal';

declare global {
  interface ElectronAPI {
    onServerEvent: (callback: (event: ServerEvent) => void) => () => void;
    sendClientEvent: (event: ClientEvent) => void;
    onTerminalEvent: (callback: (event: TerminalEventPayload) => void) => () => void;
    terminal: {
      open: (input: TerminalOpenInput) => Promise<TerminalOpenResult>;
      write: (input: TerminalWriteInput) => Promise<{ ok: boolean; message?: string }>;
      resize: (input: TerminalResizeInput) => Promise<{ ok: boolean; message?: string }>;
      clear: (input: TerminalClearInput) => Promise<{ ok: boolean; message?: string }>;
      restart: (input: TerminalRestartInput) => Promise<TerminalOpenResult>;
      close: (input: TerminalCloseInput) => Promise<{ ok: boolean; message?: string }>;
      getTransportInfo: () => Promise<TerminalTransportInfo>;
      onEvent: (callback: (event: TerminalEventPayload) => void) => () => void;
    };
    onWindowShellState: (callback: (state: { rounded: boolean }) => void) => () => void;
    registerProjectEditorFlushHandler: (
      callback: () => { ok: boolean; message?: string } | Promise<{ ok: boolean; message?: string }>
    ) => () => void;
    generateSessionTitle: (prompt: string) => Promise<string>;
    forkSession: (
      sessionId: string
    ) => Promise<{ ok: boolean; session?: SessionInfo; message?: string }>;
    sessionHandoff: (payload: {
      sessionId: string;
      targetProvider: import('./shared/types').AgentProvider;
    }) => Promise<{ ok: boolean; session?: SessionInfo; message?: string }>;
    claudeRewind: (
      input: import('./shared/types').ClaudeRewindInput
    ) => Promise<import('./shared/types').ClaudeRewindResult>;
    moveSessionToWorktree: (
      sessionId: string
    ) => Promise<{ ok: boolean; message?: string }>;
    applyWorktreeChanges: (
      sessionId: string
    ) => Promise<{ ok: boolean; message?: string; conflict?: boolean }>;
    discardWorktreeChanges: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
    getRecentCwds: (limit?: number) => Promise<string[]>;
    getAutomations: () => Promise<AutomationSnapshot>;
    saveAutomation: (input: UpsertAutomationInput) => Promise<AutomationDefinition>;
    deleteAutomation: (automationId: string) => Promise<{ ok: boolean }>;
    setAutomationEnabled: (automationId: string, enabled: boolean) => Promise<AutomationDefinition | null>;
    runAutomationNow: (automationId: string) => Promise<{ ok: boolean; sessionId?: string; message?: string }>;
    getNotificationSettings: () => Promise<{ enabled: boolean; onlyWhenUnfocused: boolean }>;
    setNotificationSettings: (next: {
      enabled?: boolean;
      onlyWhenUnfocused?: boolean;
    }) => Promise<{ enabled: boolean; onlyWhenUnfocused: boolean }>;
    startTerminalSession: (sessionId: string, cwd: string, cols?: number, rows?: number, agentKind?: TerminalAgentKind) => Promise<StartTerminalSessionResult>;
    writeTerminalSession: (sessionId: string, data: string) => Promise<{ ok: boolean; message?: string }>;
    resizeTerminalSession: (sessionId: string, cols: number, rows: number) => Promise<{ ok: boolean; message?: string }>;
    stopTerminalSession: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
    getTerminalTransportInfo: () => Promise<TerminalTransportInfo>;
    setWindowMinSize: (width: number, height: number) => Promise<{ ok: boolean }>;
    getAppVersion: () => Promise<string>;
    getWindowShellState: () => Promise<{ rounded: boolean }>;
    setTheme: (theme: 'light' | 'dark' | 'system') => Promise<{ ok: boolean }>;
    getUiResumeState: () => Promise<UiResumeState | null>;
    getUiResumeStateSync: () => UiResumeState | null;
    saveUiResumeState: (state: UiResumeState) => Promise<{ ok: boolean }>;
    rendererState: {
      getItem: (key: string) => string | null;
      setItem: (key: string, value: string) => void;
      removeItem: (key: string) => void;
    };
    updateProjectEditorDraft: (
      draft: { cwd: string; filePath: string; content: string } | null
    ) => void;
    commitProjectEditorDraftSync: (
      draft: { cwd: string; filePath: string; content: string } | null
    ) => void;
    writeProjectTextFileSync: (
      draft: { cwd: string; filePath: string; content: string }
    ) => void;
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
    getWechatHtmlGeneratorConfig: () => Promise<WechatMarkdownHtmlGeneratorConfig>;
    saveWechatHtmlGeneratorConfig: (config: WechatMarkdownHtmlGeneratorConfig) => Promise<WechatMarkdownHtmlGeneratorConfig>;
    generateWechatMarkdownHtml: (input: WechatMarkdownHtmlGenerationInput) => Promise<WechatMarkdownHtmlGenerationResult>;
    writeWechatClipboardHtml: (input: WechatClipboardHtmlWriteInput) => Promise<WechatClipboardHtmlWriteResult>;
    getClaudeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getCodexUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getCodexRateLimits: () => Promise<CodexRateLimitReport>;
    getClaudePlanUsage: () => Promise<import('./shared/types').ClaudePlanUsageReport>;
    getOpencodeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getAgentUsageReport: (
      provider: import('./shared/types').AgentProvider,
      days?: ClaudeUsageRangeDays
    ) => Promise<ClaudeUsageReport>;
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
    listCodexPlugins: (input?: Omit<ProviderListPluginsInput, 'provider'>) => Promise<ProviderListPluginsResult>;
    readCodexPlugin: (input: Omit<ProviderReadPluginInput, 'provider'>) => Promise<ProviderReadPluginResult>;
    getOpencodeModelConfig: () => Promise<OpenCodeModelConfig>;
    saveOpencodeModelVisibility: (enabledModels: string[]) => Promise<OpenCodeModelConfig>;
    getOpencodeRuntimeStatus: () => Promise<OpenCodeRuntimeStatus>; 
    getKimiModelConfig: () => Promise<KimiModelConfig>;
    getKimiRuntimeStatus: () => Promise<KimiRuntimeStatus>;
    getGrokRuntimeStatus: () => Promise<GrokRuntimeStatus>;
    getGrokModelConfig: () => Promise<GrokModelConfig>;
    getPiModelConfig: () => Promise<PiModelConfig>;
    getClaudeRuntimeStatus: (model?: string | null) => Promise<ClaudeRuntimeStatus>;
    getSkillMarketHot: (limit?: number) => Promise<SkillMarketItem[]>;
    searchSkillMarket: (query: string, limit?: number) => Promise<SkillMarketItem[]>;
    getSkillMarketDetail: (id: string) => Promise<SkillMarketDetail>;
    installSkillFromMarket: (id: string) => Promise<SkillMarketInstallResult>;
    expandClaudeSkillPrompt: (skillFilePath: string, skillName: string, userPrompt: string) => Promise<{ ok: boolean; prompt?: string; message?: string }>;
    getAgentRuntimeDirectory: (
      force?: boolean
    ) => Promise<import('./shared/types').AgentRuntimeDirectoryReport>;
    getUserProfile: () => Promise<import('./shared/types').UserProfile>;
    saveUserProfile: (
      update: import('./shared/types').UserProfileUpdate
    ) => Promise<import('./shared/types').UserProfile>;
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
    createProjectFile: (cwd: string, parentPath: string, name: string) => Promise<{ ok: boolean; path?: string; tree?: ProjectTreeNode; message?: string }>;
    createProjectFolder: (cwd: string, parentPath: string, name: string) => Promise<{ ok: boolean; path?: string; tree?: ProjectTreeNode; message?: string }>;
    moveProjectEntry: (cwd: string, sourcePath: string, targetParentPath: string) => Promise<{ ok: boolean; path?: string; tree?: ProjectTreeNode; message?: string }>;
    deleteProjectEntry: (cwd: string, targetPath: string) => Promise<{ ok: boolean; tree?: ProjectTreeNode; message?: string }>;
    selectMarkdownImageAsset: (cwd: string, markdownFilePath: string) => Promise<{ ok: boolean; relativePath?: string; name?: string; message?: string } | null>;
    readMarkdownImageAsset: (cwd: string, markdownFilePath: string, imageSrc: string) => Promise<{ ok: boolean; dataUrl?: string; message?: string }>;
    resolveMarkdownImageAssetUrl: (cwd: string, markdownFilePath: string, imageSrc: string) => Promise<{ ok: boolean; url?: string; size?: number; mtimeMs?: number; message?: string }>;
    createMarkdownImageAsset: (cwd: string, markdownFilePath: string, fileName: string, mimeType: string | undefined, data: Uint8Array) => Promise<{ ok: boolean; relativePath?: string; name?: string; message?: string }>;
    createInlineTextAttachment: (cwd: string, text: string) => Promise<Attachment | null>;
    createInlineImageAttachment: (mimeType: string, data: Uint8Array) => Promise<Attachment | null>;
    writeProjectTextFile: (cwd: string, filePath: string, content: string) => Promise<{ ok: boolean; message?: string; size?: number; mtimeMs?: number }>;
    previewArtifactPath: (cwd: string, filePath: string, options?: { openInBrowser?: boolean }) => Promise<{ ok: boolean; url?: string; message?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    revealPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    listOpenWithApps: (
      cwd: string,
      filePath: string
    ) => Promise<{ ok: boolean; apps?: Array<{ name: string; appPath: string; iconDataUrl: string | null }>; message?: string }>;
    openFileWithApp: (
      cwd: string,
      filePath: string,
      appPath: string
    ) => Promise<{ ok: boolean; message?: string }>;
    getProjectTree: (cwd: string) => Promise<ProjectTreeNode | null>;
    watchProjectTree: (cwd: string) => Promise<boolean>;
    unwatchProjectTree: (cwd: string) => Promise<boolean>;
    watchProjectFile: (cwd: string, filePath: string) => Promise<boolean>;
    unwatchProjectFile: (cwd: string, filePath: string) => Promise<boolean>;
    getGitChanges: (cwd: string) => Promise<{ ok: boolean; error: string | null; entries: import('./shared/types').GitChangeEntry[] }>;
    getGitWorkingTreeSummary: (cwd: string) => Promise<{ ok: boolean; error: string | null; insertions: number; deletions: number }>;
    getGitOverview: (cwd: string) => Promise<import('./shared/types').GitOverviewResult>;
    getGitPatch: (
      cwd: string,
      scope?: import('./shared/types').GitPatchScope
    ) => Promise<import('./shared/types').GitPatchResult>;
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
        worktreePath?: string | null;
      }>;
    }>;
    gitCheckoutBranch: (input: import('./shared/types').GitCheckoutBranchInput) => Promise<{ ok: boolean; output?: string; message?: string }>;
    gitCreateBranch: (input: import('./shared/types').GitCreateBranchInput) => Promise<{ ok: boolean; output?: string; message?: string }>;
    gitCreateWorktree: (input: import('./shared/types').GitCreateWorktreeInput) => Promise<{ ok: boolean; message?: string; worktree?: import('./shared/types').GitWorktree | null }>;
    gitSessionHandoff: (input: import('./shared/types').GitSessionHandoffInput) => Promise<{ ok: boolean; message?: string; worktree?: import('./shared/types').GitWorktree | null; session?: unknown }>;
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
    getEnvironmentEditorLaunchers: () => Promise<import('./shared/types').EnvironmentEditorLauncher[]>;
    openInEditor: (input: import('./shared/types').OpenInEditorInput) => Promise<{ ok: boolean; message?: string }>;
    getSessionEnvironmentContext: (sessionId: string) => Promise<{ ok: boolean; context?: import('./shared/types').SessionEnvironmentContext; message?: string }>;
    saveSessionEnvironmentNote: (sessionId: string, note: string) => Promise<{ ok: boolean; note?: import('./shared/types').SessionEnvironmentNote; message?: string }>;
    refreshSessionEnvironmentRecap: (sessionId: string) => Promise<{ ok: boolean; recap?: import('./shared/types').SessionEnvironmentRecap; message?: string }>;
    openExternalUrl: (url: string) => Promise<{ ok: boolean; message?: string }>;
    showNativeMenu: (input: {
      x?: number;
      y?: number;
      items?: Array<{
        id: string;
        label?: string;
        type?: 'normal' | 'separator';
        enabled?: boolean;
        accelerator?: string | null;
      }>;
    }) => Promise<{ ok: boolean; id?: string; message?: string }>;
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
    designMode: {
      enable: (
        input: import('./shared/design-mode-types').DesignModeTarget & { projectRoot: string }
      ) => Promise<import('./shared/design-mode-types').DesignEnableResult>;
      disable: (input: import('./shared/design-mode-types').DesignModeTarget) => Promise<void>;
      preview: (
        input: import('./shared/design-mode-types').DesignModeTarget & { property: string; value: string }
      ) => Promise<boolean>;
      clearPreview: (input: import('./shared/design-mode-types').DesignModeTarget) => Promise<void>;
      measureSelection: (
        input: import('./shared/design-mode-types').DesignModeTarget
      ) => Promise<{
        found: boolean;
        rect?: { x: number; y: number; w: number; h: number };
        viewport?: { w: number; h: number };
      }>;
      apply: (
        input: import('./shared/design-mode-types').DesignApplyInput
      ) => Promise<import('./shared/design-mode-types').DesignApplyResult>;
      undo: (
        input: import('./shared/design-mode-types').DesignModeTarget
      ) => Promise<{ ok: boolean; message?: string; remaining: number }>;
      rollbackLastFailed: (
        input: import('./shared/design-mode-types').DesignModeTarget
      ) => Promise<{ ok: boolean; message?: string; remaining: number }>;
      onEvent: (
        callback: (event: import('./shared/design-mode-types').DesignModeEvent) => void
      ) => () => void;
    };
  }

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
