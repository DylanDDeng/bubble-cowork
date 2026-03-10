// 全局类型声明（Window 扩展）
// 实际类型定义在 src/shared/types.ts

import type {
  ClientEvent,
  ClaudeCompatibleProvidersConfig,
  ServerEvent,
  StatisticsData,
  StaticData,
  Attachment,
  FontSettingsPayload,
  ProjectTreeNode,
  SystemFontOption,
  ClaudeModelConfig,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  CodexModelConfig,
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
    getClaudeModelConfig: () => Promise<ClaudeModelConfig>;
    getClaudeCompatibleProviderConfig: () => Promise<ClaudeCompatibleProvidersConfig>;
    saveClaudeCompatibleProviderConfig: (config: ClaudeCompatibleProvidersConfig) => Promise<ClaudeCompatibleProvidersConfig>;
    getClaudeUsageReport: (days?: ClaudeUsageRangeDays) => Promise<ClaudeUsageReport>;
    getCodexModelConfig: () => Promise<CodexModelConfig>;
    getSkillMarketHot: (limit?: number) => Promise<SkillMarketItem[]>;
    searchSkillMarket: (query: string, limit?: number) => Promise<SkillMarketItem[]>;
    getSkillMarketDetail: (id: string) => Promise<SkillMarketDetail>;
    installSkillFromMarket: (id: string) => Promise<SkillMarketInstallResult>;
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
    subscribeStatistics: (callback: (data: StatisticsData) => void) => () => void;
    getStaticData: () => Promise<StaticData>;
  }

  interface Window {
    electron: ElectronAPI;
  }
}

export {};
