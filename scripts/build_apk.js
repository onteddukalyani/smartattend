import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const srcApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const destApk = path.join(rootDir, 'SmartAttend-debug.apk');

console.log('\n🚀 Starting full SmartAttend APK build process...\n');

try {
  // 1. Build Vite Web Assets
  console.log('📦 Step 1/3: Building Web Assets (vite build)...');
  execSync('npm run build', { cwd: rootDir, stdio: 'inherit' });

  // Clean stale assets and build directories to avoid Windows file lock & snapshot issues
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
      } catch (e) {
        // ignore
      }
    }
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  try {
    execSync(`${gradlewCmd} --stop`, { cwd: androidDir, stdio: 'ignore' });
  } catch (_) {}

  console.log('\n🔨 Step 3/3: Compiling Android APK...');
  execSync(`${gradlewCmd} clean assembleDebug --no-daemon --no-build-cache`, { cwd: androidDir, stdio: 'inherit' });

  // 4. Copy to Root
  if (fs.existsSync(srcApk)) {
    fs.copyFileSync(srcApk, destApk);
    const stats = fs.statSync(destApk);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`\n========================================`);
    console.log(`✅ Build Complete!`);
    console.log(`📁 Updated APK created: SmartAttend-debug.apk (${sizeMb} MB)`);
    console.log(`📲 Ready to install on your Android device!`);
    console.log(`========================================\n`);
  } else {
    console.error('\n❌ Could not find output APK at: ' + srcApk);
    process.exit(1);
  }
} catch (err) {
  console.error('\n❌ Build process encountered an error:');
  console.error(err.message || err);
  process.exit(1);
}
