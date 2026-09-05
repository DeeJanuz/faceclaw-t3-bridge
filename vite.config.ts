import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    host: true,
    port: 5178,
    strictPort: true,
  },
  build: {
    target: 'esnext',
  },
})
