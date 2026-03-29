const { contextBridge, ipcRenderer } = require('electron');
import type {
  ClaudeCompatibleProvidersConfig,
  ClaudeUsageRangeDays,
  FeishuBridgeConfig,
  FontSettingsPayload,
  PromptLibraryExportResult,
  PromptLibraryImportResult,
  PromptLibraryItem,
  SkillMarketDetail,
  SkillMarketInstallResult,
  SkillMarketItem,
  SystemFontOption,
  UiResumeState,
  UpsertPromptLibraryItemInput,
} from '../shared/types';

// 暴露 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  // 订阅服务器事件
  onServerEvent: (callback: (event: unknown) => void) => {
    const handler = (_: unknown, eventJson: string) => {
      try {
        const event = JSON.parse(eventJson);
        callback(event);
      } catch (error) {
        console.error('Failed to parse server event:', error);
      }
    };

    ipcRenderer.on('server-event', handler);

    // 返回取消订阅函数
    return () => {
      ipcRenderer.removeListener('server-event', handler);
    };
  },

  // 发送客户端事件
  sendClientEvent: (event: unknown) => {
    ipcRenderer.send('client-event', JSON.stringify(event));
  },

  onTerminalEvent: (callback: (event: unknown) => void) => {
    const handler = (_: unknown, eventJson: string) => {
      try {
        callback(JSON.parse(eventJson));
      } catch (error) {
        console.error('Failed to parse terminal event:', error);
      }
    };

    ipcRenderer.on('terminal-event', handler);
    return () => {
      ipcRenderer.removeListener('terminal-event', handler);
    };
  },

  // 生成会话标题
  generateSessionTitle: (prompt: string) => {
    return ipcRenderer.invoke('generate-session-title', prompt);
  },

  // 获取最近工作目录
  getRecentCwds: (limit?: number) => {
    return ipcRenderer.invoke('get-recent-cwds', limit);
  },

  startTerminalSession: (sessionId: string, cwd: string, cols?: number, rows?: number) => {
    return ipcRenderer.invoke('start-terminal-session', sessionId, cwd, cols, rows);
  },

  writeTerminalSession: (sessionId: string, data: string) => {
    return ipcRenderer.invoke('write-terminal-session', sessionId, data);
  },

  resizeTerminalSession: (sessionId: string, cols: number, rows: number) => {
    return ipcRenderer.invoke('resize-terminal-session', sessionId, cols, rows);
  },

  stopTerminalSession: (sessionId: string) => {
    return ipcRenderer.invoke('stop-terminal-session', sessionId);
  },

  setWindowMinSize: (width: number, height: number) => {
    return ipcRenderer.invoke('set-window-min-size', width, height);
  },

  searchChatMessages: (query: string, limit?: number) => {
    return ipcRenderer.invoke('search-chat-messages', query, limit);
  },

  getAppVersion: () => {
    return ipcRenderer.invoke('get-app-version');
  },

  getUiResumeState: (): Promise<UiResumeState | null> => {
    return ipcRenderer.invoke('get-ui-resume-state');
  },

  getUiResumeStateSync: (): UiResumeState | null => {
    return ipcRenderer.sendSync('get-ui-resume-state-sync');
  },

  saveUiResumeState: (state: UiResumeState) => {
    return Promise.resolve(ipcRenderer.sendSync('save-ui-resume-state-sync', state));
  },

  checkForUpdates: () => {
    return ipcRenderer.invoke('check-for-updates');
  },

  // 获取 Claude 模型配置
  getClaudeModelConfig: () => {
    return ipcRenderer.invoke('get-claude-model-config');
  },

  // 获取 Claude-compatible provider 配置
  getClaudeCompatibleProviderConfig: () => {
    return ipcRenderer.invoke('get-claude-compatible-provider-config');
  },

  // 保存 Claude-compatible provider 配置
  saveClaudeCompatibleProviderConfig: (config: ClaudeCompatibleProvidersConfig) => {
    return ipcRenderer.invoke('save-claude-compatible-provider-config', config);
  },

  // 获取 Claude usage 报表
  getClaudeUsageReport: (days?: ClaudeUsageRangeDays) => {
    return ipcRenderer.invoke('get-claude-usage-report', days);
  },

  getCodexUsageReport: (days?: ClaudeUsageRangeDays) => {
    return ipcRenderer.invoke('get-codex-usage-report', days);
  },

  getOpencodeUsageReport: (days?: ClaudeUsageRangeDays) => {
    return ipcRenderer.invoke('get-opencode-usage-report', days);
  },

  getPromptLibrary: (): Promise<PromptLibraryItem[]> => {
    return ipcRenderer.invoke('get-prompt-library');
  },

  savePromptLibraryItem: (input: UpsertPromptLibraryItemInput): Promise<PromptLibraryItem[]> => {
    return ipcRenderer.invoke('save-prompt-library-item', input);
  },

  deletePromptLibraryItem: (id: string): Promise<PromptLibraryItem[]> => {
    return ipcRenderer.invoke('delete-prompt-library-item', id);
  },

  importPromptLibrary: (): Promise<PromptLibraryImportResult> => {
    return ipcRenderer.invoke('import-prompt-library');
  },

  exportPromptLibrary: (): Promise<PromptLibraryExportResult> => {
    return ipcRenderer.invoke('export-prompt-library');
  },

  // 获取 Codex 模型配置
  getCodexModelConfig: () => {
    return ipcRenderer.invoke('get-codex-model-config');
  },

  saveCodexModelVisibility: (enabledModels: string[]) => {
    return ipcRenderer.invoke('save-codex-model-visibility', enabledModels);
  },

  getCodexRuntimeStatus: () => {
    return ipcRenderer.invoke('get-codex-runtime-status');
  },

  getOpencodeModelConfig: () => {
    return ipcRenderer.invoke('get-opencode-model-config');
  },

  saveOpencodeModelVisibility: (enabledModels: string[]) => {
    return ipcRenderer.invoke('save-opencode-model-visibility', enabledModels);
  },

  getOpencodeRuntimeStatus: () => {
    return ipcRenderer.invoke('get-opencode-runtime-status');
  },

  getClaudeRuntimeStatus: (model?: string | null) => {
    return ipcRenderer.invoke('get-claude-runtime-status', model);
  },

  getSkillMarketHot: (limit?: number): Promise<SkillMarketItem[]> => {
    return ipcRenderer.invoke('get-skill-market-hot', limit);
  },
  searchSkillMarket: (query: string, limit?: number): Promise<SkillMarketItem[]> => {
    return ipcRenderer.invoke('search-skill-market', query, limit);
  },
  getSkillMarketDetail: (id: string): Promise<SkillMarketDetail> => {
    return ipcRenderer.invoke('get-skill-market-detail', id);
  },
  installSkillFromMarket: (id: string): Promise<SkillMarketInstallResult> => {
    return ipcRenderer.invoke('install-skill-from-market', id);
  },
  expandClaudeSkillPrompt: (skillFilePath: string, skillName: string, userPrompt: string) => {
    return ipcRenderer.invoke('expand-claude-skill-prompt', skillFilePath, skillName, userPrompt);
  },

  getFeishuBridgeConfig: () => {
    return ipcRenderer.invoke('get-feishu-bridge-config');
  },
  saveFeishuBridgeConfig: (config: FeishuBridgeConfig) => {
    return ipcRenderer.invoke('save-feishu-bridge-config', config);
  },
  getFeishuBridgeStatus: () => {
    return ipcRenderer.invoke('get-feishu-bridge-status');
  },
  startFeishuBridge: () => {
    return ipcRenderer.invoke('start-feishu-bridge');
  },
  stopFeishuBridge: () => {
    return ipcRenderer.invoke('stop-feishu-bridge');
  },

  // 字体设置
  getFontSettings: () => {
    return ipcRenderer.invoke('get-font-settings');
  },
  saveFontSelections: (selections: FontSettingsPayload['selections']) => {
    return ipcRenderer.invoke('save-font-selections', selections);
  },
  listSystemFonts: () => {
    return ipcRenderer.invoke('list-system-fonts');
  },
  importFontFile: () => {
    return ipcRenderer.invoke('import-font-file');
  },
  deleteImportedFont: (fontId: string) => {
    return ipcRenderer.invoke('delete-imported-font', fontId);
  },

  // 选择目录
  selectDirectory: () => {
    return ipcRenderer.invoke('select-directory');
  },

  // 选择附件（文件/图片）
  selectAttachments: () => {
    return ipcRenderer.invoke('select-attachments');
  },

  // 读取图片预览（data URL）
  readAttachmentPreview: (filePath: string) => {
    return ipcRenderer.invoke('read-attachment-preview', filePath);
  },

  // 读取项目文件预览
  readProjectFilePreview: (cwd: string, filePath: string) => {
    return ipcRenderer.invoke('read-project-file-preview', cwd, filePath);
  },

  createProjectAttachment: (cwd: string, filePath: string) => {
    return ipcRenderer.invoke('create-project-attachment', cwd, filePath);
  },

  // 保存项目文本文件（仅 .txt）
  writeProjectTextFile: (cwd: string, filePath: string, content: string) => {
    return ipcRenderer.invoke('write-project-text-file', cwd, filePath, content);
  },

  // 用系统默认应用打开文件
  openPath: (filePath: string) => {
    return ipcRenderer.invoke('open-path', filePath);
  },

  // 在文件管理器中展示文件
  revealPath: (filePath: string) => {
    return ipcRenderer.invoke('reveal-path', filePath);
  },

  // 获取项目文件树
  getProjectTree: (cwd: string) => {
    return ipcRenderer.invoke('get-project-tree', cwd);
  },

  // 订阅项目文件树更新
  watchProjectTree: (cwd: string) => {
    return ipcRenderer.invoke('watch-project-tree', cwd);
  },

  // 取消订阅项目文件树更新
  unwatchProjectTree: (cwd: string) => {
    return ipcRenderer.invoke('unwatch-project-tree', cwd);
  },

  // Git 变更
  getGitChanges: (cwd: string) => {
    return ipcRenderer.invoke('get-git-changes', cwd);
  },

  getGitBranch: (cwd: string) => {
    return ipcRenderer.invoke('get-git-branch', cwd);
  },

  getGitBranches: (cwd: string) => {
    return ipcRenderer.invoke('get-git-branches', cwd);
  },

  getGitHistory: (cwd: string) => {
    return ipcRenderer.invoke('get-git-history', cwd);
  },

  getGitDiff: (cwd: string, filePath: string) => {
    return ipcRenderer.invoke('get-git-diff', cwd, filePath);
  },

  gitStagePath: (cwd: string, filePath: string) => {
    return ipcRenderer.invoke('git-stage-path', cwd, filePath);
  },

  gitUnstagePath: (cwd: string, filePath: string) => {
    return ipcRenderer.invoke('git-unstage-path', cwd, filePath);
  },

  gitDiscardPath: (cwd: string, filePath: string, status?: string) => {
    return ipcRenderer.invoke('git-discard-path', cwd, filePath, status);
  },

  gitCommit: (cwd: string, message: string) => {
    return ipcRenderer.invoke('git-commit', cwd, message);
  },

  gitPush: (cwd: string) => {
    return ipcRenderer.invoke('git-push', cwd);
  },

  // 订阅系统统计（预留）
  subscribeStatistics: (callback: (data: unknown) => void) => {
    const handler = (_: unknown, data: unknown) => {
      callback(data);
    };

    ipcRenderer.on('statistics', handler);

    return () => {
      ipcRenderer.removeListener('statistics', handler);
    };
  },

  // 获取静态数据（预留）
  getStaticData: () => {
    return ipcRenderer.invoke('getStaticData');
  },
});
