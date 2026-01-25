import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [react(), tailwindcss(), tsconfigPaths()],
  server: {
    port: parseInt(process.env.PORT || '10087'),
    strictPort: true,
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
