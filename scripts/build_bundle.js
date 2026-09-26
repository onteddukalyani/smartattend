import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const srcAab = path.join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const destAab = path.join(rootDir, 'SmartAttend-release.aab');

console.log('\n🚀 Starting SmartAttend Production AAB (Google Play Bundle) build process...\n');

try {
  // 1. Build Vite Web Assets
  console.log('📦 Step 1/3: Building Production Web Assets (vite build)...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

  // Clean stale assets
  const stalePublicAssets = path.join(androidDir, 'app', 'src', 'main', 'assets', 'public');
  if (fs.existsSync(stalePublicAssets)) {
    try {
      fs.rmSync(stalePublicAssets, { recursive: true, force: true });
    } catch (e) {}
  }

  // 2. Sync Capacitor
  console.log('\n🔄 Step 2/3: Syncing Capacitor Android Assets...');
  execSync('npx cap sync android', { cwd: rootDir, stdio: 'inherit' });

  const cleanDirs = [
    path.join(rootDir, 'node_modules', '@capacitor', 'android', 'capacitor', 'build'),
    path.join(rootDir, 'node_modules', '@capacitor', 'android', 'build'),
    path.join(rootDir, 'node_modules', '@capacitor', 'app', 'android', 'build'),
    path.join(rootDir, 'node_modules', '@capacitor-firebase', 'authentication', 'android', 'build'),
    path.join(androidDir, 'app', 'build'),
    path.join(androidDir, 'capacitor-cordova-android-plugins', 'build')
  ];
  for (const dir of cleanDirs) {
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e) {}
    }
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  try {
    execSync(`${gradlewCmd} --stop`, { cwd: androidDir, stdio: 'ignore' });
  } catch (_) {}

  // 3. Compile Signed AAB Bundle
  console.log('\n🔨 Step 3/3: Compiling Signed Android App Bundle (bundleRelease)...');
  execSync(`${gradlewCmd} bundleRelease --no-daemon --no-build-cache`, { cwd: androidDir, stdio: 'inherit' });

  // 4. Copy to Root
  if (fs.existsSync(srcAab)) {
    fs.copyFileSync(srcAab, destAab);
    const stats = fs.statSync(destAab);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`\n======================================================`);
    console.log(`✅ Google Play App Bundle Created Successfully!`);
    console.log(`📁 File: SmartAttend-release.aab (${sizeMb} MB)`);
    console.log(`🚀 Ready to upload directly to Google Play Console!`);
    console.log(`======================================================\n`);
  } else {
    console.error('\n❌ Could not find output AAB at: ' + srcAab);
    process.exit(1);
  }
} catch (err) {
  console.error('\n❌ Bundle build process encountered an error:');
  console.error(err.message || err);
  process.exit(1);
}
