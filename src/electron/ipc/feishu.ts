/**
 * 飞书桥接模块
 *
 * 管理飞书企业应用的配置和状态。
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import { feishuBridge } from '../libs/feishu-bridge'
import { loadFeishuBridgeConfig, saveFeishuBridgeConfig } from '../libs/feishu-bridge-config'
import type { FeishuBridgeConfig } from '../../shared/types'

export function register(_ctx: IPCHandlerContext): void {
  ipcMainHandle('get-feishu-bridge-config', async () => {
    return loadFeishuBridgeConfig()
  })

  ipcMainHandle('save-feishu-bridge-config', async (_event, config: FeishuBridgeConfig) => {
    return saveFeishuBridgeConfig(config)
  })

  ipcMainHandle('get-feishu-bridge-status', async () => {
    return feishuBridge.getStatus()
  })

  ipcMainHandle('start-feishu-bridge', async () => {
    return feishuBridge.start()
  })

  ipcMainHandle('stop-feishu-bridge', async () => {
    return feishuBridge.stop()
  })
}
