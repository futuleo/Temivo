import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Workspace packages ship TypeScript sources, so they must be bundled rather than externalized.
const bundledWorkspaceDeps = ['@temivo/core'];

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundledWorkspaceDeps },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundledWorkspaceDeps },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
