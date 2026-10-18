package com.smartattend.app;

import android.Manifest;
import android.app.ActivityOptions;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;
import java.lang.reflect.Method;

public class MainActivity extends BridgeActivity {
    private static MainActivity sInstance;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean isReordering = false;
    private boolean isPaused = false;

    public static MainActivity getInstance() {
        return sInstance;
    }

    public boolean isActivityPaused() {
        return isPaused;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme_NoActionBar);
        sInstance = this;
        registerPlugin(KioskPlugin.class);
        registerPlugin(BiometricPlugin.class);
        registerPlugin(NativeNotificationPlugin.class);
        super.onCreate(savedInstanceState);

        // Enable Chrome remote debugging for WebView
        WebView.setWebContentsDebuggingEnabled(true);

        // Explicitly request runtime permissions on launch: Camera, Fine & Coarse Location, and Notifications
        java.util.List<String> neededPermissions = new java.util.ArrayList<>();
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.CAMERA);
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
            neededPermissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            neededPermissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!neededPermissions.isEmpty()) {
            ActivityCompat.requestPermissions(this, neededPermissions.toArray(new String[0]), 100);
        }

        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                WebView webView = getBridge().getWebView();
                webView.getSettings().setGeolocationEnabled(true);
                webView.getSettings().setGeolocationDatabasePath(getFilesDir().getPath());
            }
        } catch (Throwable t) {
            android.util.Log.w("MainActivity", "WebView geolocation config notice: " + t.getMessage());
        }


    }

    public void bringToFront() {
        if (!KioskPlugin.isKioskEnforced || isReordering) return;
        isReordering = true;
        mainHandler.post(() -> {
            try {
                // Send broadcast to close system dialogs/notification pull-downs
                Intent closeDialogs = new Intent(Intent.ACTION_CLOSE_SYSTEM_DIALOGS);
                sendBroadcast(closeDialogs);
            } catch (Exception ignored) {}

            try {
                Intent intent = new Intent(MainActivity.this, MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                
                int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    flags |= PendingIntent.FLAG_IMMUTABLE;
                }
                
                Bundle options = null;
                if (Build.VERSION.SDK_INT >= 34) {
                    try {
                        ActivityOptions actOpts = ActivityOptions.makeBasic();
                        Method method = ActivityOptions.class.getMethod("setPendingIntentBackgroundActivityStartMode", int.class);
                        method.invoke(actOpts, 1);
                        options = actOpts.toBundle();
                    } catch (Exception ignored) {}
                }

                PendingIntent pi = PendingIntent.getActivity(MainActivity.this, 0, intent, flags);
                try {
                    if (options != null) {
                        pi.send(MainActivity.this, 0, null, null, null, null, options);
                    } else {
                        pi.send();
                    }
                } catch (Exception e) {
                    startActivity(intent, options);
                }
            } catch (Exception ignored) {}
            
            mainHandler.postDelayed(() -> isReordering = false, 400);
        });
    }

    @Override
    public void onBackPressed() {
        if (KioskPlugin.isKioskEnforced) {
            // Block hardware/software back navigation during active attendance kiosk session
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (KioskPlugin.isKioskEnforced) {
            bringToFront();
        }
    }

    @Override
    public void onPause() {
        isPaused = true;
        super.onPause();
        if (KioskPlugin.isKioskEnforced) {
            bringToFront();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (KioskPlugin.isKioskEnforced) {
            int keyCode = event.getKeyCode();
            if (keyCode == KeyEvent.KEYCODE_BACK ||
                keyCode == KeyEvent.KEYCODE_APP_SWITCH ||
                keyCode == KeyEvent.KEYCODE_HOME ||
                keyCode == KeyEvent.KEYCODE_VOLUME_UP ||
                keyCode == KeyEvent.KEYCODE_VOLUME_DOWN ||
                keyCode == KeyEvent.KEYCODE_POWER) {
                return true; // Block hardware keys during active kiosk session
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (KioskPlugin.isKioskEnforced) {
            if (hasFocus) {
                KioskPlugin.applyImmersiveMode(this);
            } else if (isPaused) {
                bringToFront();
            }
        }
    }

    @Override
    public void onResume() {
        isPaused = false;
        super.onResume();
        if (KioskPlugin.isKioskEnforced) {
            KioskPlugin.reEnforceKiosk(this);
        }
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) {
            sInstance = null;
        }
        super.onDestroy();
    }
}
