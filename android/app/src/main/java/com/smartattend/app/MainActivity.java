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

    private void bringToFront() {
        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            startActivity(intent);
        } catch (Exception ignored) {}
    }
}

