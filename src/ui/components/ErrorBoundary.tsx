import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** 当此 key 变化时，重置错误状态 */
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error?: Error;
  prevResetKey?: string | number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // 当 resetKey 变化时，重置错误状态
    // 这允许在内容变化时重新尝试渲染
    if (
      state.hasError &&
      props.resetKey !== undefined &&
      props.resetKey !== state.prevResetKey
    ) {
      return {
        hasError: false,
        error: undefined,
        prevResetKey: props.resetKey,
      };
    }
    // 保存当前的 resetKey 以便下次比较
    if (props.resetKey !== state.prevResetKey) {
      return { prevResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg">
          <p className="text-sm text-red-400">渲染出错，请刷新页面</p>
        </div>
      );
    }
    return this.props.children;
  }
}
