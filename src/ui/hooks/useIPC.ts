import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { ClientEvent, ServerEvent } from '../types';

// IPC 通信 Hook
export function useIPC() {
  const { setConnected, handleServerEvent } = useAppStore();

  useEffect(() => {
    // 订阅服务器事件
    const unsubscribe = window.electron.onServerEvent((event: ServerEvent) => {
      handleServerEvent(event);
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
  window.electron.sendClientEvent(event);
}
