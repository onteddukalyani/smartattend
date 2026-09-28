import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vite.dev/config/
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    {
      name: 'apk-mime-type',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url && req.url.endsWith('.apk')) {
            const filename = req.url.split('/').pop().split('?')[0] || 'SmartAttend-release.apk';
            const apkPath = path.join(__dirname, filename);
            if (fs.existsSync(apkPath)) {
              res.setHeader('Content-Type', 'application/vnd.android.package-archive');
              res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
              return fs.createReadStream(apkPath).pipe(res);
            }
          }
          next();
        });
      }
    }
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

