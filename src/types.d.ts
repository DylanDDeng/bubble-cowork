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
    generateSessionTitle: (prompt: string) => Promise<string>;
    getRecentCwds: (limit?: number) => Promise<string[]>;
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
    getGitDiff: (cwd: string, filePath: string) => Promise<string>;
    subscribeStatistics: (callback: (data: StatisticsData) => void) => () => void;
    getStaticData: () => Promise<StaticData>;
  }

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
