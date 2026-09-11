import { getHistorySourceForSession, toUnifiedSessionRecord } from '../libs/history/registry';
import { writeFile } from 'node:fs/promises';
import { BrowserWindow, clipboard, dialog, ShareMenu, shell } from 'electron';
import type { SessionOrganizationChange } from '../../shared/session-organization';
import { ipcMainHandle } from '../util';
import * as sessions from '../libs/session-store';

export function setupSessionOrganizationIPC() {
  ipcMainHandle('get-session-organization', () => sessions.getSessionOrganization());
  ipcMainHandle('change-session-organization', (_, change: SessionOrganizationChange) => {
    const snapshot = sessions.changeSessionOrganization(change);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session-organization-changed', snapshot);
    }
    return snapshot;
  });
  ipcMainHandle('export-session-markdown', async (event, sessionId: string, share: boolean) => {
    const markdown = await getSessionMarkdown(sessionId);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('The window is no longer available.');
    const title = sessions.getSession(sessionId)!.title.replace(/[/\\:*?"<>|\x00-\x1f]/g, '-').slice(0, 100) || 'Conversation';
    const result = await dialog.showSaveDialog(win, {
      title: share ? 'Export conversation to share' : 'Export conversation',
      defaultPath: `${title}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }],
      message: 'Exports user and assistant text. Attachments and tool output are not included.',
    });
    if (result.canceled || !result.filePath) return;
    await writeFile(result.filePath, markdown, 'utf8');
    if (share && process.platform === 'darwin') new ShareMenu({ filePaths: [result.filePath] }).popup({ window: win });
    else shell.showItemInFolder(result.filePath);
  });
  ipcMainHandle('copy-session-markdown', async (_, sessionId: string) => {
    clipboard.writeText(await getSessionMarkdown(sessionId));
  });
}

export async function getSessionMarkdown(sessionId: string): Promise<string> {
  const session = typeof sessionId === 'string' ? sessions.getSession(sessionId) : undefined;
  if (!session || session.hidden_from_threads) throw new Error('This task is no longer available.');
  const parts = [`# ${session.title}\n`];
  const unified = toUnifiedSessionRecord(session);
  for (const message of await getHistorySourceForSession(unified).loadAll(unified)) {
    const record = message as unknown as Record<string, any>;
    if (record.parent_tool_use_id || record.parentToolUseId) continue;
    if (!['user_prompt', 'user', 'assistant'].includes(message.type)) continue;
    const content = record.message?.content;
    const text = typeof record.prompt === 'string' ? record.prompt : typeof content === 'string' ? content :
      Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n\n') : '';
    if (!text.trim()) continue;
    parts.push(`## ${message.type === 'assistant' ? 'Assistant' : 'User'}\n\n${text}\n`);
  }
  return parts.join('\n');
}
