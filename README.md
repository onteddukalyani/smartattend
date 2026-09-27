# 🎓 SmartAttend — Next-Gen AI Biometric & Dynamic QR Attendance System

![SmartAttend Banner](https://img.shields.io/badge/SmartAttend-IIIT%20Dharwad-6366f1?style=for-the-badge&logo=google-cloud&logoColor=white)
![React 19](https://img.shields.io/badge/React-19.2-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8.2-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Firebase](https://img.shields.io/badge/Firebase-12.18-FFCA28?style=for-the-badge&logo=firebase&logoColor=black)
![Capacitor](https://img.shields.io/badge/Capacitor-8.5-119EFF?style=for-the-badge&logo=capacitor&logoColor=white)
![Android APK](https://img.shields.io/badge/Android-APK%20Ready-3DDC84?style=for-the-badge&logo=android&logoColor=white)

**SmartAttend** is an enterprise-grade, anti-proxy institutional attendance governance platform built for **IIIT Dharwad**. It features a dual-layer verification engine combining **128-dimensional AI Facial Biometrics** and **Time-Rotating Dynamic QR Codes** to completely eliminate proxy attendances while streamlining class analytics for faculty and administration.

---

## 🌟 Key Features

### 🛡️ Dual Anti-Proxy Attendance Verification
- **128-D AI Face Recognition**: High-precision facial biometrics powered by `@vladmandic/face-api` (SSD MobileNet V1 + FaceLandmark68Net + FaceRecognitionNet) with on-device liveness detection.
- **Dynamic Rotating QR Codes**: Session QR codes that auto-rotate (QR 1 & QR 2) with a strict 3-minute timer countdown, early QR 2 switchover, and automatic device locking upon session conclusion.
- **Biometric Liveness Guard**: Prevents spoofing using static images, screen photos, or video replays.

### 👨‍🎓 Student Experience
- **Live Attendance Dashboard**: Real-time attendance percentage calculations across all enrolled courses with instant shortage alerts (<75%).
- **Interactive Scanning**: High-speed camera scanner with immediate face biometric verification and attendance submission confirmation.
- **Profile & Biometrics Management**: Instant photo upload, WhatsApp/Instagram-style modal preview, display name editing, and self-service semester enrollment update (Semesters 1–8).
- **Course & Session Analytics**: Detailed subject breakdown, verified presence logs, and attendance history.

### 👩‍🏫 Lecturer / Faculty Workspace
- **Session Control Room**: 1-click dynamic QR generation with subject, department (CSE, DSAI, ECE, AIC), semester, and hall selection.
- **Live Attendance Monitoring**: Real-time check-in stream displaying student names, roll numbers, timestamps, and verification status.
- **Manual Overrides & Roster Management**: Mark present/absent manually with administrative audit logs.
- **Excel Export**: Single-click export of complete attendance registers and course rosters formatted for university reporting.

### 👑 Administrative Governance Hub
- **Executive KPI Overview**: Deduplicated real-time metrics tracking Total Students, Active Faculty, System Administrators, Sessions, and Attendance Records.
- **User & Access Control**: Full directory management for Students, Lecturers, and Administrators with Google OAuth RBAC permissions.
- **Course Catalog Management**: Add, update, and organize department courses (CSE, DSAI, ECE, AIC) and academic terms.
- **System-Wide Reports**: Institutional attendance analytics and exportable Excel reports.

---

## 🏗️ Architecture & Technology Stack

| Layer | Technology | Description |
| :--- | :--- | :--- |
| **Frontend UI** | **React 19 + Vite 8** | Modern reactive architecture with React Compiler support and ultra-fast HMR |
| **Styling** | **Custom Design System (CSS3)** | Responsive, glassmorphic UI with light/midnight theme support |
| **Database & Auth** | **Cloud Firestore & Firebase Auth** | Real-time NoSQL synchronization with Google OAuth 2.0 institutional login |
| **AI Biometrics** | **Face-API & MediaPipe** | Client-side 128-D vector embeddings calculation and Euclidean distance matching |
| **Mobile Runtime** | **Capacitor 8 (Android SDK)** | Native Android integration, camera hardware access, and cross-platform bridge |
| **Data Export** | **SheetJS (XLSX)** | Automated Excel report generation for attendance and user registries |

---

## 📁 Repository Structure

```text
smartattend/
├── android/                 # Capacitor Android Native Project & Gradle Config
│   ├── app/                 # Android App module & Native Manifests
│   └── build.gradle         # Gradle build configurations
├── public/                  # Static assets (Face-API models, icons, manifests)
│   └── models/              # Pretrained neural net weights (SSD MobileNet, Landmarks)
├── scripts/                 # Automated build and maintenance scripts
│   ├── build_apk.js         # Build Android Debug APK (SmartAttend-debug.apk)
│   ├── build_release_apk.js # Build Signed Release APK (SmartAttend-release.apk)
│   ├── build_bundle.js      # Generate Android App Bundle (.aab)
│   └── serve_apk.js         # Local network APK distribution server
├── src/
│   ├── components/
│   │   ├── Admin/           # Admin Dashboard, Manage Users, Overview, Courses
│   │   ├── Lecturer/        # QR Generator, Active Sessions, Student Lists
│   │   ├── Student/         # Student Dashboard, QR Scanner, Statistics
│   │   ├── Common/          # Settings, Profile Photo Modal, Face Enrollment, Modals
│   │   ├── authcontext.jsx  # Global Auth & Role-Based Access Provider
│   │   └── firebase.js      # Firebase SDK Initialization
│   ├── utils/               # Biometric hashing, attendance math, data helpers
│   ├── App.jsx              # Main Router & Route Guards
│   └── main.jsx             # React DOM Root
├── package.json             # NPM dependencies and scripts
└── vite.config.js           # Vite configuration & Babel React Compiler plugin
```

---

## 🚀 Getting Started

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **NPM**: v9.0.0 or higher
- **Java JDK**: JDK 17 (for compiling Android APKs)
- **Android SDK / Android Studio** (for native mobile builds)

### 1. Clone & Install Dependencies
```bash
git clone https://github.com/onteddukalyani/smartattend.git
cd smartattend
npm install
```

### 2. Configure Firebase
Ensure your Firebase credentials in [`src/firebase.js`](src/firebase.js) are configured with your project API keys:
```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Run Development Server
```bash
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 📱 Building & Distributing Android APK

SmartAttend is configured with automated Capacitor build scripts that bundle web assets and compile Android APKs with a single command:

### 🔨 Build Debug APK
```bash
npm run build:apk
```
> Outputs: `SmartAttend-release.apk` in the project root.

### 📦 Build Signed Release APK
```bash
npm run build:release
```
> Outputs: `SmartAttend-release.apk` ready for direct mobile distribution or testing.

### 🌐 Distribute Over Local WiFi / LAN
To download the APK directly to physical Android devices on the same Wi-Fi network:
```bash
npm run serve:apk
```
Scan the generated terminal QR code with your phone to instantly download and install the APK.

---

## 🔒 Security & Privacy Features

1. **On-Device Biometric Processing**: Face descriptors are computed entirely in the browser/client environment using WebAssembly and WebGL. Raw biometric photos are never transferred across networks without explicit user consent.
2. **Session Tamper Prevention**: Session tokens and dynamic QR hashes are cryptographically verified in Firestore with expiration timestamps.
3. **Role-Based Access Control (RBAC)**: Enforced via Firestore security rules and contextual authentication guards (`StudentRoute`, `LecturerRoute`, `AdminRoute`).
4. **Google Workspace Whitelisting**: Restricts login access to authorized institutional email domains (`@iiitdwd.ac.in`).

---

## 📄 License & Attribution

Developed with ❤️ for **Indian Institute of Information Technology (IIIT) Dharwad**.

Licensed under the [MIT License](LICENSE).