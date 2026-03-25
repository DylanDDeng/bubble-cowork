// 全局类型声明（Window 扩展）
// 实际类型定义在 src/shared/types.ts

import type {
  ClientEvent,
  ClaudeCompatibleProvidersConfig,
  ServerEvent,
  StatisticsData,
  StaticData,
  Attachment,
  ChatMessageSearchResult,
  FontSettingsPayload,
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
  SkillMarketItem,
  SkillMarketDetail,
  SkillMarketInstallResult,
  FeishuBridgeConfig,
  FeishuBridgeStatus,
} from './shared/types';

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
    checkForUpdates: () => Promise<{ ok: boolean }>;
    getClaudeModelConfig: () => Promise<ClaudeModelConfig>;
    getClaudeCompatibleProviderConfig: () => Promise<ClaudeCompatibleProvidersConfig>;
    saveClaudeCompatibleProviderConfig: (config: ClaudeCompatibleProvidersConfig) => Promise<ClaudeCompatibleProvidersConfig>;
    getClaudeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getCodexUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getOpencodeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getPromptLibrary: () => Promise<PromptLibraryItem[]>;
    savePromptLibraryItem: (input: UpsertPromptLibraryItemInput) => Promise<PromptLibraryItem[]>;
    deletePromptLibraryItem: (id: string) => Promise<PromptLibraryItem[]>;
    importPromptLibrary: () => Promise<PromptLibraryImportResult>;
    exportPromptLibrary: () => Promise<PromptLibraryExportResult>;
    searchChatMessages: (query: string, limit?: number) => Promise<ChatMessageSearchResult[]>;
    getCodexModelConfig: () => Promise<CodexModelConfig>;
    saveCodexModelVisibility: (enabledModels: string[]) => Promise<CodexModelConfig>;
    getCodexRuntimeStatus: () => Promise<CodexRuntimeStatus>;
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
    startFeishuBridge: () => Promise<FeishuBridgeStatus>;
    stopFeishuBridge: () => Promise<FeishuBridgeStatus>;
    selectDirectory: () => Promise<string | null>;
    selectAttachments: () => Promise<Attachment[]>;
    readAttachmentPreview: (filePath: string) => Promise<string | null>;
    readProjectFilePreview: (cwd: string, filePath: string) => Promise<unknown>;
    writeProjectTextFile: (cwd: string, filePath: string, content: string) => Promise<{ ok: boolean; message?: string }>;
    openPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    revealPath: (filePath: string) => Promise<{ ok: boolean; message?: string }>;
    getProjectTree: (cwd: string) => Promise<ProjectTreeNode | null>;
    watchProjectTree: (cwd: string) => Promise<boolean>;
    unwatchProjectTree: (cwd: string) => Promise<boolean>;
    getGitChanges: (cwd: string) => Promise<{ ok: boolean; error: string | null; entries: Array<{ filePath: string; status: string; staged: boolean }> }>;
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
    gitPush: (cwd: string) => Promise<{ ok: boolean; message?: string; output?: string }>;
    subscribeStatistics: (callback: (data: StatisticsData) => void) => () => void;
    getStaticData: () => Promise<StaticData>;
  }

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
