package com.smartattend.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean isReordering = false;

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
            // Block back navigation during active attendance kiosk session
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (KioskPlugin.isKioskEnforced && !isReordering) {
            isReordering = true;
            mainHandler.postDelayed(() -> {
                try {
                    Intent intent = new Intent(MainActivity.this, MainActivity.class);
                    intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    startActivity(intent);
                } catch (Exception ignored) {}
                isReordering = false;
            }, 250);
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (KioskPlugin.isKioskEnforced) {
            int keyCode = event.getKeyCode();
            if (keyCode == KeyEvent.KEYCODE_BACK) {
                return true; // Block physical back key during session
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (KioskPlugin.isKioskEnforced && hasFocus) {
            KioskPlugin.applyImmersiveMode(this);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        if (KioskPlugin.isKioskEnforced) {
            KioskPlugin.reEnforceKiosk(this);
        }
    }
}
