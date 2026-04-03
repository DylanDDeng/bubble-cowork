import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Reset error state when this key changes */
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
    // Reset error state when resetKey changes
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
    // Save current resetKey for comparison
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
          <p className="text-sm text-red-400">Rendering error. Please refresh the page.</p>
        </div>
      );
    }
    return this.props.children;
  }
}
