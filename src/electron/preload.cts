const { contextBridge, ipcRenderer } = require('electron');

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

  // 生成会话标题
  generateSessionTitle: (prompt: string) => {
    return ipcRenderer.invoke('generate-session-title', prompt);
  },

  // 获取最近工作目录
  getRecentCwds: (limit?: number) => {
    return ipcRenderer.invoke('get-recent-cwds', limit);
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
