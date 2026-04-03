import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
});

window.addEventListener('error', (event) => {
  console.error('Uncaught error:', event.error);
});

function GlobalErrorFallback() {
  return (
    <div className="h-screen w-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="text-center p-8 max-w-md">
        <div className="mb-5 flex justify-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--error)]/10">
            <svg className="h-6 w-6 text-[var(--error)]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
          </div>
        </div>
        <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
          Something went wrong
        </h1>
        <p className="text-sm text-[var(--text-secondary)] mb-5">
          The application encountered an unexpected error. Please try refreshing or restarting the app.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="px-5 py-2.5 bg-[var(--accent)] text-[var(--accent-foreground)] rounded-[var(--radius-xl)] font-medium text-sm hover:bg-[var(--accent-hover)] transition-colors"
        >
          Refresh Page
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
