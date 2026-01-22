import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { FolderConfig, FolderConfigFile } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'folders-config.json');

// ===== 默认配置 =====
export function getDefaultFolderConfig(): FolderConfigFile {
  return {
    version: 1,
    folders: [],
  };
}

// ===== 加载配置 =====
export function loadFolderConfig(): FolderConfigFile {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return getDefaultFolderConfig();
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as FolderConfigFile;
    return config;
  } catch {
    return getDefaultFolderConfig();
  }
}

// ===== 保存配置 =====
export function saveFolderConfig(config: FolderConfigFile): void {
  writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

// ===== 验证路径格式 =====
function validateFolderPath(path: string): string {
  // 移除首尾斜杠和空白
  let cleanPath = path.trim().replace(/^\/+|\/+$/g, '');
  // 移除连续斜杠
  cleanPath = cleanPath.replace(/\/+/g, '/');
  // 禁止空路径
  if (!cleanPath) {
    throw new Error('Folder path cannot be empty');
  }
  // 禁止空段（如 "Work//Project"）
  if (cleanPath.split('/').some(segment => !segment.trim())) {
    throw new Error('Folder path contains empty segments');
  }
  // 禁止特殊字符（仅允许字母、数字、空格、下划线、连字符、中文）
  const invalidChars = /[<>:"|?*\\]/;
  if (invalidChars.test(cleanPath)) {
    throw new Error('Folder path contains invalid characters');
  }
  return cleanPath;
}

// ===== 列出文件夹 =====
export function listFolders(): FolderConfig[] {
  const config = loadFolderConfig();
  return config.folders.sort((a, b) => a.order - b.order);
}

// ===== 创建文件夹 =====
export function createFolder(path: string, displayName?: string): FolderConfig {
  const config = loadFolderConfig();
  const cleanPath = validateFolderPath(path);

  // 检查是否已存在
  if (config.folders.some(f => f.path === cleanPath)) {
    throw new Error(`Folder '${cleanPath}' already exists`);
  }

  // 自动创建父文件夹
  const segments = cleanPath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const parentPath = segments.slice(0, i).join('/');
    if (!config.folders.some(f => f.path === parentPath)) {
      const parentOrder = Math.max(...config.folders.map(f => f.order), -1) + 1;
      config.folders.push({
        path: parentPath,
        order: parentOrder,
      });
    }
  }

  const maxOrder = Math.max(...config.folders.map(f => f.order), -1);
  const folder: FolderConfig = {
    path: cleanPath,
    displayName: displayName || undefined,
    order: maxOrder + 1,
  };

  config.folders.push(folder);
  saveFolderConfig(config);
  return folder;
}

// ===== 更新文件夹 =====
export function updateFolder(path: string, updates: Partial<FolderConfig>): FolderConfig {
  const config = loadFolderConfig();
  const cleanPath = validateFolderPath(path);
  const folder = config.folders.find(f => f.path === cleanPath);

  if (!folder) {
    throw new Error(`Folder '${cleanPath}' not found`);
  }

  // 不允许通过 update 修改 path，使用 moveFolder
  const { path: _, ...safeUpdates } = updates;
  Object.assign(folder, safeUpdates);
  saveFolderConfig(config);
  return folder;
}

// ===== 删除文件夹 =====
export function deleteFolder(path: string): FolderConfig[] {
  const config = loadFolderConfig();
  const cleanPath = validateFolderPath(path);

  // 删除该文件夹及所有子文件夹
  const deletedFolders = config.folders.filter(
    f => f.path === cleanPath || f.path.startsWith(cleanPath + '/')
  );

  if (deletedFolders.length === 0) {
    throw new Error(`Folder '${cleanPath}' not found`);
  }

  config.folders = config.folders.filter(
    f => f.path !== cleanPath && !f.path.startsWith(cleanPath + '/')
  );

  saveFolderConfig(config);
  return deletedFolders;
}

// ===== 移动/重命名文件夹 =====
export function moveFolder(oldPath: string, newPath: string): { oldPaths: string[]; newPaths: string[] } {
  const config = loadFolderConfig();
  const cleanOldPath = validateFolderPath(oldPath);
  const cleanNewPath = validateFolderPath(newPath);

  if (cleanOldPath === cleanNewPath) {
    return { oldPaths: [], newPaths: [] };
  }

  // 检查目标是否已存在
  if (config.folders.some(f => f.path === cleanNewPath)) {
    throw new Error(`Folder '${cleanNewPath}' already exists`);
  }

  // 检查是否尝试移动到自己的子目录下
  if (cleanNewPath.startsWith(cleanOldPath + '/')) {
    throw new Error('Cannot move folder into its own subdirectory');
  }

  const oldPaths: string[] = [];
  const newPaths: string[] = [];

  // 更新该文件夹及所有子文件夹的路径
  for (const folder of config.folders) {
    if (folder.path === cleanOldPath) {
      oldPaths.push(folder.path);
      folder.path = cleanNewPath;
      newPaths.push(folder.path);
    } else if (folder.path.startsWith(cleanOldPath + '/')) {
      oldPaths.push(folder.path);
      folder.path = cleanNewPath + folder.path.slice(cleanOldPath.length);
      newPaths.push(folder.path);
    }
  }

  if (oldPaths.length === 0) {
    throw new Error(`Folder '${cleanOldPath}' not found`);
  }

  // 自动创建新父文件夹
  const segments = cleanNewPath.split('/');
  for (let i = 1; i < segments.length; i++) {
    const parentPath = segments.slice(0, i).join('/');
    if (!config.folders.some(f => f.path === parentPath)) {
      const parentOrder = Math.max(...config.folders.map(f => f.order), -1) + 1;
      config.folders.push({
        path: parentPath,
        order: parentOrder,
      });
    }
  }

  saveFolderConfig(config);
  return { oldPaths, newPaths };
}

// ===== 获取文件夹 =====
export function getFolder(path: string): FolderConfig | undefined {
  const config = loadFolderConfig();
  const cleanPath = validateFolderPath(path);
  return config.folders.find(f => f.path === cleanPath);
}

// ===== 确保文件夹存在（用于 session.setFolder 时自动创建）=====
export function ensureFolderExists(path: string): FolderConfig {
  const config = loadFolderConfig();
  const cleanPath = validateFolderPath(path);

  let folder = config.folders.find(f => f.path === cleanPath);
  if (folder) {
    return folder;
  }

  // 自动创建文件夹及其父文件夹
  const segments = cleanPath.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const currentPath = segments.slice(0, i).join('/');
    if (!config.folders.some(f => f.path === currentPath)) {
      const order = Math.max(...config.folders.map(f => f.order), -1) + 1;
      const newFolder: FolderConfig = {
        path: currentPath,
        order,
      };
      config.folders.push(newFolder);
      if (currentPath === cleanPath) {
        folder = newFolder;
      }
    } else if (currentPath === cleanPath) {
      folder = config.folders.find(f => f.path === currentPath);
    }
  }

  saveFolderConfig(config);
  return folder!;
}
