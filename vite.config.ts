import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 4173, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: ['es2022', 'safari14'] },
});
