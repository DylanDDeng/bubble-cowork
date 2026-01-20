// 全局类型声明（Window 扩展）
// 实际类型定义在 src/shared/types.ts

import type { ClientEvent, ServerEvent, StatisticsData, StaticData, Attachment, ProjectTreeNode } from './shared/types';

declare global {
  interface ElectronAPI {
    onServerEvent: (callback: (event: ServerEvent) => void) => () => void;
    sendClientEvent: (event: ClientEvent) => void;
    generateSessionTitle: (prompt: string) => Promise<string>;
    getRecentCwds: (limit?: number) => Promise<string[]>;
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
