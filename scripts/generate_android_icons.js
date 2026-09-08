import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const BROWSER_PATH = EDGE_PATHS.find(p => fs.existsSync(p));
if (!BROWSER_PATH) {
  console.error('No supported browser found for rendering');
  process.exit(1);
}

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
const svgContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'favicon.svg'), 'utf8');

// Target sizes mapping
const densities = [
  { name: 'mipmap-mdpi', iconSize: 48, fgSize: 108 },
  { name: 'mipmap-hdpi', iconSize: 72, fgSize: 162 },
  { name: 'mipmap-xhdpi', iconSize: 96, fgSize: 216 },
  { name: 'mipmap-xxhdpi', iconSize: 144, fgSize: 324 },
  { name: 'mipmap-xxxhdpi', iconSize: 192, fgSize: 432 }
];

// Helper to generate HTML file
function createHtml(type, size) {
  let innerHtml = '';
  if (type === 'foreground') {
    // Transparent background with centered logo
    innerHtml = `
      <body style="margin:0; padding:0; background:transparent; width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
        <div style="width:66%; height:66%; display:flex; align-items:center; justify-content:center;">
          ${svgContent}
        </div>
      </body>
    `;
  } else if (type === 'round') {
    // White circular background with centered logo
    innerHtml = `
      <body style="margin:0; padding:0; background:transparent; width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
        <div style="width:100%; height:100%; border-radius:50%; background:#ffffff; box-shadow:inset 0 0 0 1px rgba(99,102,241,0.15); display:flex; align-items:center; justify-content:center; overflow:hidden;">
          <div style="width:72%; height:72%; display:flex; align-items:center; justify-content:center;">
            ${svgContent}
          </div>
        </div>
      </body>
    `;
  } else {
    // Square icon with soft rounded corners on white background
    innerHtml = `
      <body style="margin:0; padding:0; background:transparent; width:${size}px; height:${size}px; display:flex; align-items:center; justify-content:center; overflow:hidden;">
        <div style="width:100%; height:100%; border-radius:22%; background:#ffffff; box-shadow:inset 0 0 0 1px rgba(99,102,241,0.15); display:flex; align-items:center; justify-content:center; overflow:hidden;">
          <div style="width:72%; height:72%; display:flex; align-items:center; justify-content:center;">
            ${svgContent}
          </div>
        </div>
      </body>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    svg { width:100%; height:100%; display:block; }
  </style>
</head>
${innerHtml}
</html>`;
}

// Generate all icons
async function run() {
  const tempDir = path.join(__dirname, 'temp_icons');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  for (const d of densities) {
    const outDir = path.join(RES_DIR, d.name);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // 1. ic_launcher.png (Square / Squircle)
    const squareHtmlPath = path.join(tempDir, `square_${d.iconSize}.html`);
    fs.writeFileSync(squareHtmlPath, createHtml('square', d.iconSize));
    const squareOut = path.join(outDir, 'ic_launcher.png');
    execSync(`"${BROWSER_PATH}" --headless --disable-gpu --default-background-color=00000000 --force-device-scale-factor=1 --window-size=${d.iconSize},${d.iconSize} --screenshot="${squareOut}" "file://${squareHtmlPath.replace(/\\/g, '/')}"`);

    // 2. ic_launcher_round.png (Round)
    const roundHtmlPath = path.join(tempDir, `round_${d.iconSize}.html`);
    fs.writeFileSync(roundHtmlPath, createHtml('round', d.iconSize));
    const roundOut = path.join(outDir, 'ic_launcher_round.png');
    execSync(`"${BROWSER_PATH}" --headless --disable-gpu --default-background-color=00000000 --force-device-scale-factor=1 --window-size=${d.iconSize},${d.iconSize} --screenshot="${roundOut}" "file://${roundHtmlPath.replace(/\\/g, '/')}"`);

    // 3. ic_launcher_foreground.png (Adaptive Foreground)
    const fgHtmlPath = path.join(tempDir, `fg_${d.fgSize}.html`);
    fs.writeFileSync(fgHtmlPath, createHtml('foreground', d.fgSize));
    const fgOut = path.join(outDir, 'ic_launcher_foreground.png');
    execSync(`"${BROWSER_PATH}" --headless --disable-gpu --default-background-color=00000000 --force-device-scale-factor=1 --window-size=${d.fgSize},${d.fgSize} --screenshot="${fgOut}" "file://${fgHtmlPath.replace(/\\/g, '/')}"`);

    console.log(`Generated icons for ${d.name} (${d.iconSize}px / ${d.fgSize}px)`);
  }

  // Cleanup temp files
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('All launcher icons generated successfully!');
}

run();
