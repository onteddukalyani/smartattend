import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@vladmandic/face-api')) {
            return 'vendor-faceapi';
          }
          if (id.includes('xlsx')) {
            return 'vendor-xlsx';
          }
          if (id.includes('@yudiel/react-qr-scanner') || id.includes('jsqr') || id.includes('qrcode')) {
            return 'vendor-qr';
          }
          if (id.includes('firebase')) {
            return 'vendor-firebase';
          }
          if (id.includes('react-icons')) {
            return 'vendor-icons';
          }
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/')) {
            return 'vendor-react';
          }
        }
      }
    }
  },
  server: {
    host: true,
    watch: {
      ignored: ['**/android/**', '**/dist/**']
    }
  }
})

