import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// 导入 highlight.js 样式
import 'highlight.js/styles/github-dark.css';

// 全局错误处理 - 捕获未处理的 Promise 错误
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

// 全局错误处理 - 捕获未处理的 JS 错误
window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
});

// 全局错误 fallback UI
function GlobalErrorFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="text-center p-8 max-w-md">
        <div className="text-6xl mb-4">⚠️</div>
        <h1 className="text-xl font-semibold text-[var(--text-primary)] mb-2">
          应用渲染出错
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-4">
          请尝试刷新页面或重启应用
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg hover:bg-[var(--accent-hover)] transition-colors"
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallback={<GlobalErrorFallback />}>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
