import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  server: {
    host: '127.0.0.1',
    port: parseInt(process.env.PORT || '10087'),
    strictPort: true,
    watch: {
      // Design mode writes into dev-fixtures at runtime; Aegis's own dev
      // server must not react to those files (they have their own server).
      // Isolated-copy threads check a full worktree out under .worktrees/ —
      // its tsconfig.json alone makes Vite force a full-reload of the app.
      ignored: ['**/dev-fixtures/**', '**/.worktrees/**'],
    },
  },
  optimizeDeps: {
    include: ['sonner'],
  },
  build: {
    outDir: 'dist-react',
    emptyOutDir: process.env.VITE_BUILD_WATCH !== '1',
  },
  base: './',
});
