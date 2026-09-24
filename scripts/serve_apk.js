import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const apkPath = path.join(rootDir, 'SmartAttend-debug.apk');

if (!fs.existsSync(apkPath)) {
  console.error('❌ Error: SmartAttend-debug.apk not found in project root directory.');
  process.exit(1);
}

const stats = fs.statSync(apkPath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
const PORT = 8080;

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/SmartAttend-debug.apk' || url === '/download' || url === '/app.apk') {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="SmartAttend-debug.apk"',
      'Content-Length': stats.size,
      'Access-Control-Allow-Origin': '*'
    });
    const stream = fs.createReadStream(apkPath);
    stream.pipe(res);
    return;
  }

  // HTML landing page for mobile browser download
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Download SmartAttend APK</title>
      <style>
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        body {
          background: #0f172a;
          color: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          padding: 20px;
        }
        .card {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 24px;
          padding: 32px 24px;
          max-width: 420px;
          width: 100%;
          text-align: center;
          box-shadow: 0 20px 40px rgba(0,0,0,0.4);
        }
        .icon {
          width: 70px;
          height: 70px;
          background: rgba(99, 102, 241, 0.15);
          color: #818cf8;
          border-radius: 20px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          margin: 0 auto 20px;
        }
        h1 { font-size: 22px; margin: 0 0 8px; font-weight: 800; }
        p { color: #94a3b8; font-size: 14px; margin: 0 0 24px; line-height: 1.5; }
        .badge {
          display: inline-block;
          background: rgba(16, 185, 129, 0.15);
          color: #34d399;
          padding: 6px 14px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 700;
          margin-bottom: 24px;
        }
        .btn {
          display: block;
          background: linear-gradient(135deg, #6366f1 0%, #4f46e5 100%);
          color: #ffffff;
          text-decoration: none;
          padding: 16px 24px;
          border-radius: 16px;
          font-weight: 800;
          font-size: 16px;
          box-shadow: 0 10px 25px rgba(99, 102, 241, 0.4);
          transition: transform 0.1s;
        }
        .btn:active { transform: scale(0.98); }
        .instructions {
          margin-top: 24px;
          text-align: left;
          background: #0f172a;
          padding: 16px;
          border-radius: 12px;
          font-size: 12px;
          color: #94a3b8;
          line-height: 1.6;
        }
        .instructions strong { color: #cbd5e1; }
      </style>
    </head>
    <body>
      <div class="card">
        <div class="icon">📲</div>
        <h1>SmartAttend Android App</h1>
        <p>Lecturer-Controlled MDM Attendance App with FaceIO Biometrics</p>
        <div class="badge">Size: ${sizeMb} MB &bull; Version: 1.0 Debug</div>
        <a href="/SmartAttend-debug.apk" class="btn" download="SmartAttend-debug.apk">
          ⬇️ Download APK (${sizeMb} MB)
        </a>
        <div class="instructions">
          <strong>Installation steps:</strong><br>
          1. Tap <strong>Download APK</strong> above.<br>
          2. When Chrome prompts <em>"File might be harmful"</em>, tap <strong>Download anyway</strong>.<br>
          3. Tap <strong>Open</strong> and allow <em>"Install unknown apps"</em> for your browser if asked.<br>
          4. Tap <strong>Install</strong>.
        </div>
      </div>
    </body>
    </html>
  `);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIpAddresses();
  console.log('\n=============================================================');
  console.log('🚀 SmartAttend APK Mobile Download Server is LIVE!');
  console.log('=============================================================');
  console.log(`\n📱 Open any of these URLs in your mobile browser to download:\n`);
  ips.forEach((ip) => {
    console.log(`   👉 http://${ip}:${PORT}/`);
    console.log(`   👉 Direct Link: http://${ip}:${PORT}/SmartAttend-debug.apk`);
  });
  console.log(`\n   💻 Local PC: http://localhost:${PORT}/`);
  console.log('\n=============================================================\n');
});
