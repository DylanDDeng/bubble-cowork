import { app } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { StatusConfig, StatusConfigFile, CreateStatusInput, UpdateStatusInput } from '../../shared/types';

const CONFIG_PATH = () => join(app.getPath('userData'), 'status-config.json');

// ===== 默认配置 =====
export function getDefaultStatusConfig(): StatusConfigFile {
  return {
    version: 1,
    statuses: [
      { id: 'backlog', label: 'Backlog', category: 'open', isFixed: false, isDefault: true, order: 0 },
      { id: 'todo', label: 'Todo', category: 'open', isFixed: true, isDefault: false, order: 1 },
      { id: 'needs-review', label: 'Needs Review', category: 'open', isFixed: false, isDefault: true, order: 2 },
      { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 3 },
      { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 4 },
    ],
    defaultStatusId: 'todo',
  };
}

// ===== 验证配置 =====
function validateConfig(config: StatusConfigFile): boolean {
  const requiredIds = ['todo', 'done', 'cancelled'];
  const existingIds = new Set(config.statuses.map(s => s.id));
  return requiredIds.every(id => existingIds.has(id));
}

// ===== 加载配置 =====
export function loadStatusConfig(): StatusConfigFile {
  const configPath = CONFIG_PATH();
  if (!existsSync(configPath)) {
    return getDefaultStatusConfig();
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as StatusConfigFile;
    // 验证必需的 fixed 状态存在
    if (!validateConfig(config)) {
      return getDefaultStatusConfig();
    }
    return config;
  } catch {
    return getDefaultStatusConfig();
  }
}

// ===== 保存配置 =====
export function saveStatusConfig(config: StatusConfigFile): void {
  writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

// ===== 列出状态 =====
export function listStatuses(): StatusConfig[] {
  const config = loadStatusConfig();
  return config.statuses.sort((a, b) => a.order - b.order);
}

// ===== 生成 slug =====
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ===== 创建状态 =====
export function createStatus(input: CreateStatusInput): StatusConfig {
  const config = loadStatusConfig();

  // 生成 slug ID
  let id = slugify(input.label);
  let suffix = 2;
  while (config.statuses.some(s => s.id === id)) {
    id = `${slugify(input.label)}-${suffix++}`;
  }

  const maxOrder = Math.max(...config.statuses.map(s => s.order), -1);
  const status: StatusConfig = {
    id,
    label: input.label,
    color: input.color,
    icon: input.icon,
    category: input.category,
    isFixed: false,
    isDefault: false,
    order: maxOrder + 1,
  };

  config.statuses.push(status);
  saveStatusConfig(config);
  return status;
}

// ===== 更新状态 =====
export function updateStatus(id: string, updates: UpdateStatusInput): StatusConfig {
  const config = loadStatusConfig();
  const status = config.statuses.find(s => s.id === id);
  if (!status) throw new Error(`Status '${id}' not found`);

  // Fixed 状态不能改 category
  if (status.isFixed && updates.category && updates.category !== status.category) {
    throw new Error('Cannot change category of fixed status');
  }

  Object.assign(status, updates);
  saveStatusConfig(config);
  return status;
}

// ===== 删除状态 =====
export function deleteStatus(id: string): void {
  const config = loadStatusConfig();
  const status = config.statuses.find(s => s.id === id);
  if (!status) throw new Error(`Status '${id}' not found`);
  if (status.isFixed) throw new Error(`Cannot delete fixed status '${id}'`);
  if (status.isDefault) throw new Error(`Cannot delete default status '${id}'`);

  config.statuses = config.statuses.filter(s => s.id !== id);
  saveStatusConfig(config);

  // TODO: 迁移使用该状态的会话到 'todo'
}

// ===== 重排序 =====
export function reorderStatuses(orderedIds: string[]): void {
  const config = loadStatusConfig();
  for (let i = 0; i < orderedIds.length; i++) {
    const status = config.statuses.find(s => s.id === orderedIds[i]);
    if (status) status.order = i;
  }
  saveStatusConfig(config);
}

// ===== 获取默认状态 ID =====
export function getDefaultStatusId(): string {
  const config = loadStatusConfig();
  return config.defaultStatusId;
}
