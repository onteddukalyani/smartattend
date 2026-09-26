import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const targetPkgPath = path.join(
  rootDir,
  'node_modules',
  '@capacitor-firebase',
  'authentication',
  'Package.swift'
);

const swift59PackageContent = `// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorFirebaseAuthentication",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapacitorFirebaseAuthentication",
            targets: ["FirebaseAuthenticationPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(url: "https://github.com/firebase/firebase-ios-sdk.git", .upToNextMajor(from: "11.0.0")),
        .package(url: "https://github.com/google/GoogleSignIn-iOS", .upToNextMajor(from: "8.0.0"))
    ],
    targets: [
        .target(
            name: "FirebaseAuthenticationPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "FirebaseAuth", package: "firebase-ios-sdk"),
                .product(name: "FirebaseCore", package: "firebase-ios-sdk"),
                .product(name: "GoogleSignIn", package: "GoogleSignIn-iOS")
            ],
            path: "ios/Plugin",
            swiftSettings: [
                .define("RGCFA_INCLUDE_GOOGLE")
            ])
    ],
    swiftLanguageVersions: [.v5]
)
`;

if (fs.existsSync(targetPkgPath)) {
  fs.writeFileSync(targetPkgPath, swift59PackageContent, 'utf8');
  console.log('✅ Patched @capacitor-firebase/authentication Package.swift to Swift tools 5.9 (compatible with Xcode 15 & 16)');
} else {
  console.log('ℹ️ Target Package.swift not found in node_modules (will be patched during CI build).');
}
