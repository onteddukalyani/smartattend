package com.smartattend.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KioskPlugin.class);
        super.onCreate(savedInstanceState);

        // Enable Chrome remote debugging for WebView
        WebView.setWebContentsDebuggingEnabled(true);

        // Explicitly request camera runtime permission on launch if not already granted
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{
                Manifest.permission.CAMERA
            }, 100);
        }
    }

    @Override
    public void onBackPressed() {
        if (KioskPlugin.isKioskEnforced) {
            // Block hardware/software back button escaping during active attendance kiosk session
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (KioskPlugin.isKioskEnforced) {
            // User attempted to press Home or perform swipe gesture to leave the app
            bringToFront();
            KioskPlugin.reEnforceKiosk(this);
        }
    }

    public void startKioskWatchdog() {
        mainHandler.removeCallbacks(kioskWatchdogRunnable);
        mainHandler.post(kioskWatchdogRunnable);
    }

    public void stopKioskWatchdog() {
        mainHandler.removeCallbacks(kioskWatchdogRunnable);
    }

    private final Runnable kioskWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            if (KioskPlugin.isKioskEnforced) {
                try {
                    android.app.ActivityManager am = (android.app.ActivityManager) getSystemService(android.content.Context.ACTIVITY_SERVICE);
                    if (am != null && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                        int lockState = am.getLockTaskModeState();
                        if (lockState == android.app.ActivityManager.LOCK_TASK_MODE_NONE) {
                            bringToFront();
                            KioskPlugin.reEnforceKiosk(MainActivity.this);
                        }
                    }
                } catch (Exception ignored) {}
                mainHandler.postDelayed(this, 350);
            }
        }
    };

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (KioskPlugin.isKioskEnforced) {
            if (!hasFocus) {
                // User pulled down notification shade or triggered screen unpin gesture
                try {
                    Intent closeDialogs = new Intent(Intent.ACTION_CLOSE_SYSTEM_DIALOGS);
                    sendBroadcast(closeDialogs);
                } catch (Exception ignored) {}

                mainHandler.postDelayed(() -> {
                    if (KioskPlugin.isKioskEnforced) {
                        bringToFront();
                        KioskPlugin.reEnforceKiosk(this);
                    }
                }, 50);

                mainHandler.postDelayed(() -> {
                    if (KioskPlugin.isKioskEnforced) {
                        bringToFront();
                        KioskPlugin.reEnforceKiosk(this);
                    }
                }, 200);
            } else {
                KioskPlugin.reEnforceKiosk(this);
            }
        }
    }

    @Override
    public boolean dispatchKeyEvent(android.view.KeyEvent event) {
        if (KioskPlugin.isKioskEnforced) {
            int keyCode = event.getKeyCode();
            if (keyCode == android.view.KeyEvent.KEYCODE_BACK ||
                keyCode == android.view.KeyEvent.KEYCODE_HOME ||
                keyCode == android.view.KeyEvent.KEYCODE_APP_SWITCH ||
                keyCode == android.view.KeyEvent.KEYCODE_WINDOW ||
                keyCode == android.view.KeyEvent.KEYCODE_SEARCH) {
                return true; // Block event entirely
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onStop() {
        super.onStop();
        if (KioskPlugin.isKioskEnforced) {
            bringToFront();
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        if (KioskPlugin.isKioskEnforced) {
            bringToFront();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (KioskPlugin.isKioskEnforced) {
            KioskPlugin.reEnforceKiosk(this);
        }
    }

    @Override
    public void onAttachedToWindow() {
        super.onAttachedToWindow();
        if (KioskPlugin.isKioskEnforced) {
            KioskPlugin.reEnforceKiosk(this);
        }
    }

    public void bringToFront() {
        if (!KioskPlugin.isKioskEnforced) return;
        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK |
                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT |
                Intent.FLAG_ACTIVITY_SINGLE_TOP |
                Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED
            );
            startActivity(intent);
        } catch (Exception ignored) {}
    }
}

