import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const androidDir = path.join(rootDir, 'android');
const srcApk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const destApk = path.join(rootDir, 'SmartAttend-release.apk');

console.log('\n🚀 Starting SmartAttend Signed Release APK build process...\n');

try {
  // 0. Clean any previous .apk files from public, dist, and native assets to prevent recursive bloat
  const dirsToCleanApks = [
    path.join(rootDir, 'public'),
    path.join(rootDir, 'dist'),
    path.join(androidDir, 'app', 'src', 'main', 'assets', 'public')
  ];
  for (const d of dirsToCleanApks) {
    if (fs.existsSync(d)) {
      try {
        const files = fs.readdirSync(d);
        for (const f of files) {
          if (f.endsWith('.apk') || f.endsWith('.aab')) {
            fs.unlinkSync(path.join(d, f));
          }
        }
      } catch (_) {}
    }
  }

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

  // Ensure no .apk was copied into native assets
  if (fs.existsSync(stalePublicAssets)) {
    try {
      const files = fs.readdirSync(stalePublicAssets);
      for (const f of files) {
        if (f.endsWith('.apk')) {
          fs.unlinkSync(path.join(stalePublicAssets, f));
        }
      }
    } catch (_) {}
  }

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

  // Remove previous output APKs
  if (fs.existsSync(srcApk)) {
    try { fs.unlinkSync(srcApk); } catch (_) {}
  }
  if (fs.existsSync(destApk)) {
    try { fs.unlinkSync(destApk); } catch (_) {}
  }

  const gradlewCmd = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
  try {
    execSync(`${gradlewCmd} --stop`, { cwd: androidDir, stdio: 'ignore' });
  } catch (_) {}

  // 3. Compile Signed Release APK
  console.log('\n🔨 Step 3/3: Compiling Signed Release APK (assembleRelease with --rerun-tasks)...');
  execSync(`${gradlewCmd} assembleRelease --no-daemon --rerun-tasks`, { cwd: androidDir, stdio: 'inherit' });

  // 4. Copy to Root and dist/
  if (fs.existsSync(srcApk)) {
    fs.copyFileSync(srcApk, destApk);
    fs.copyFileSync(srcApk, path.join(rootDir, 'SmartAttend-debug.apk'));

    const distDir = path.join(rootDir, 'dist');
    if (fs.existsSync(distDir)) {
      fs.copyFileSync(srcApk, path.join(distDir, 'SmartAttend-release.apk'));
      fs.copyFileSync(srcApk, path.join(distDir, 'SmartAttend-debug.apk'));
    }

    const stats = fs.statSync(destApk);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`\n======================================================`);
    console.log(`✅ Signed Release APK Created Successfully!`);
    console.log(`📁 File: SmartAttend-release.apk (${sizeMb} MB)`);
    console.log(`📲 Lightweight, clean release APK ready for mobile distribution!`);
    console.log(`======================================================\n`);
  } else {
    console.error('\n❌ Could not find output APK at: ' + srcApk);
    process.exit(1);
  }
} catch (err) {
  console.error('\n❌ Release APK build process encountered an error:');
  console.error(err.message || err);
  process.exit(1);
}
