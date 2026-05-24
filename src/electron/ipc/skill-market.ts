/**
 * skill-market 模块
 *
 * 从 ipc-handlers.ts 自动提取
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import {
  getSkillMarketDetail,
  getSkillMarketHot,
  installSkillFromMarket,
  searchSkillMarket,
} from '../libs/skill-market'
import { expandClaudeSkillPrompt } from '../libs/claude-skills'

export function register(_ctx: IPCHandlerContext): void {
  ipcMainHandle('get-skill-market-hot', async (_event, limit?: number) => {
    return getSkillMarketHot(limit);
  });

  ipcMainHandle('search-skill-market', async (_event, query: string, limit?: number) => {
    return searchSkillMarket(query, limit);
  });

  ipcMainHandle('get-skill-market-detail', async (_event, id: string) => {
    return getSkillMarketDetail(id);
  });

  ipcMainHandle('install-skill-from-market', async (_event, id: string) => {
    return installSkillFromMarket(id);
  });

  ipcMainHandle(
    'expand-claude-skill-prompt',
    async (_event, skillFilePath: string, skillName: string, userPrompt: string) => {
      try {
        return {
          ok: true,
          prompt: expandClaudeSkillPrompt({
            skillFilePath,
            skillName,
            userPrompt,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );
}
