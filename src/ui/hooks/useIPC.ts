import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ClientEvent, ServerEvent } from '../types';

// IPC 通信 Hook
export function useIPC() {
  const { setConnected, handleServerEvent } = useAppStore();

  useEffect(() => {
    if (typeof window === 'undefined' || !window.electron?.onServerEvent) {
      console.error('[IPC] window.electron is unavailable in renderer');
      setConnected(false);
      return;
    }

    // 订阅服务器事件
    const unsubscribe = window.electron.onServerEvent((event: ServerEvent) => {
      try {
        handleServerEvent(event);
      } catch (error) {
        console.error('[IPC] Server event handling error:', error);
        // 错误不会传播到 React，防止全局崩溃
      }
    });

    // 标记已连接
    setConnected(true);

    // 清理
    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [setConnected, handleServerEvent]);
}

// 发送事件的便捷函数
export function sendEvent(event: ClientEvent): void {
  if (!window.electron?.sendClientEvent) {
    console.error('[IPC] sendClientEvent unavailable', event);
    return;
  }
  window.electron.sendClientEvent(event);
}
