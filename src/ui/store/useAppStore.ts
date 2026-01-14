import { create } from 'zustand';
import type {
  AppState,
  AppActions,
  SessionView,
  ServerEvent,
  SessionInfo,
  StreamMessage,
} from '../types';

type Store = AppState & AppActions;
type SetState = (
  partial: Store | Partial<Store> | ((state: Store) => Store | Partial<Store>)
) => void;

export const useAppStore = create<Store>((set, get) => ({
  // 状态
  connected: false,
  sessions: {},
  activeSessionId: null,
  showStartModal: false,
  globalError: null,
  pendingStart: false,

  // Actions
  setConnected: (connected) => set({ connected }),

  handleServerEvent: (event: ServerEvent) => {
    switch (event.type) {
      case 'session.list':
        handleSessionList(event.payload.sessions, set, get);
        break;

      case 'session.status':
        handleSessionStatus(event.payload, set, get);
        break;

      case 'session.history':
        handleSessionHistory(event.payload, set);
        break;

      case 'session.deleted':
        handleSessionDeleted(event.payload.sessionId, set, get);
        break;

      case 'stream.user_prompt':
        handleUserPrompt(event.payload, set);
        break;

      case 'stream.message':
        handleStreamMessage(event.payload, set);
        break;

      case 'permission.request':
        handlePermissionRequest(event.payload, set);
        break;

      case 'runner.error':
        set({ globalError: event.payload.message });
        break;
    }
  },

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),

  setShowStartModal: (show) => set({ showStartModal: show }),

  clearGlobalError: () => set({ globalError: null }),

  setPendingStart: (pending) => set({ pendingStart: pending }),

  removePermissionRequest: (sessionId, toolUseId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;

      return {
        ...state,
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            permissionRequests: session.permissionRequests.filter(
              (r) => r.toolUseId !== toolUseId
            ),
          },
        },
      };
    });
  },
}));

// 处理会话列表
function handleSessionList(
  sessions: SessionInfo[],
  set: SetState,
  get: () => Store
) {
  const sessionsMap: Record<string, SessionView> = {};

  for (const session of sessions) {
    const existing = get().sessions[session.id];
    sessionsMap[session.id] = {
      id: session.id,
      title: session.title,
      status: session.status,
      cwd: session.cwd,
      claudeSessionId: session.claudeSessionId,
      messages: existing?.messages || [],
      hydrated: existing?.hydrated || false,
      permissionRequests: existing?.permissionRequests || [],
    };
  }

  // 如果没有会话，显示新建弹窗
  const showStartModal = sessions.length === 0;

  // 默认选中最新更新的会话
  let activeSessionId = get().activeSessionId;
  if (!activeSessionId && sessions.length > 0) {
    activeSessionId = sessions[0].id; // 已按 updated_at 降序排列
  }

  set({
    sessions: sessionsMap,
    showStartModal,
    activeSessionId,
  });
}

// 处理会话状态更新
function handleSessionStatus(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    title?: string;
    cwd?: string;
  },
  set: SetState,
  get: () => Store
) {
  const { sessionId, status, title, cwd } = payload;
  const state = get();
  const session = state.sessions[sessionId];

  if (session) {
    // 更新现有会话
    set({
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          status,
          title: title || session.title,
          cwd: cwd || session.cwd,
        },
      },
    });
  } else {
    // 新建会话（来自 session.start）
    const newSession: SessionView = {
      id: sessionId,
      title: title || 'New Session',
      status,
      cwd,
      messages: [],
      hydrated: true, // 新会话不需要 hydration
      permissionRequests: [],
    };

    set({
      sessions: {
        ...state.sessions,
        [sessionId]: newSession,
      },
      activeSessionId: sessionId,
      showStartModal: false,
      pendingStart: false,
    });
  }
}

// 处理会话历史
function handleSessionHistory(
  payload: {
    sessionId: string;
    status: SessionInfo['status'];
    messages: StreamMessage[];
  },
  set: SetState
) {
  const { sessionId, status, messages } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          status,
          messages,
          hydrated: true,
        },
      },
    };
  });
}

// 处理会话删除
function handleSessionDeleted(
  sessionId: string,
  set: SetState,
  get: () => Store
) {
  const state = get();
  const { [sessionId]: deleted, ...rest } = state.sessions;

  // 如果删除的是当前活动会话，选择另一个
  let newActiveId = state.activeSessionId;
  if (state.activeSessionId === sessionId) {
    const remaining = Object.keys(rest);
    newActiveId = remaining.length > 0 ? remaining[0] : null;
  }

  set({
    sessions: rest,
    activeSessionId: newActiveId,
    showStartModal: Object.keys(rest).length === 0,
  });
}

// 处理用户 prompt
function handleUserPrompt(
  payload: { sessionId: string; prompt: string },
  set: SetState
) {
  const { sessionId, prompt } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    const userMessage: StreamMessage = { type: 'user_prompt', prompt };

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, userMessage],
        },
      },
    };
  });
}

// 处理流式消息
function handleStreamMessage(
  payload: { sessionId: string; message: StreamMessage },
  set: SetState
) {
  const { sessionId, message } = payload;

  set((state) => {
    const session = state.sessions[sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [sessionId]: {
          ...session,
          messages: [...session.messages, message],
        },
      },
    };
  });
}

// 处理权限请求
function handlePermissionRequest(
  payload: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
  },
  set: SetState
) {
  set((state) => {
    const session = state.sessions[payload.sessionId];
    if (!session) return state;

    return {
      ...state,
      sessions: {
        ...state.sessions,
        [payload.sessionId]: {
          ...session,
          permissionRequests: [
            ...session.permissionRequests,
            payload as typeof session.permissionRequests[0],
          ],
        },
      },
    };
  });
}
