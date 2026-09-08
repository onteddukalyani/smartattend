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

  // 2. Sync Capacitor
  console.log('\n🔄 Step 2/3: Syncing Capacitor Android Assets...');
  execSync('npx cap sync android', { cwd: rootDir, stdio: 'inherit' });

  // 3. Clean and Compile APK with Gradle
  console.log('\n⚙️  Step 3/3: Compiling Android APK with Gradle...');
  const appBuildDir = path.join(androidDir, 'app', 'build');
  if (fs.existsSync(appBuildDir)) {
    try {
      fs.rmSync(appBuildDir, { recursive: true, force: true });
    } catch (_) {}
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  execSync(`${gradlewCmd} assembleDebug`, { cwd: androidDir, stdio: 'inherit' });

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
