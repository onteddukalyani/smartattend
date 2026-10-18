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

        // On app launch after install, present complete instructions for Restricted Settings & Overlay Permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            android.content.SharedPreferences prefs = getSharedPreferences("smartattend_prefs", MODE_PRIVATE);
            boolean alreadyPrompted = prefs.getBoolean("prompted_overlay_on_launch", false);
            if (!alreadyPrompted) {
                prefs.edit().putBoolean("prompted_overlay_on_launch", true).apply();
                mainHandler.postDelayed(() -> {
                    try {
                        if (isFinishing() || isDestroyed()) return;
                        boolean isAndroid13Plus = Build.VERSION.SDK_INT >= 33;
                        androidx.appcompat.app.AlertDialog.Builder builder = new androidx.appcompat.app.AlertDialog.Builder(
                            new androidx.appcompat.view.ContextThemeWrapper(this, R.style.AppTheme_NoActionBar)
                        );
                    if (isAndroid13Plus) {
                        builder.setTitle("⚠️ Action Required: Allow Restricted Settings & Overlay")
                            .setMessage("SmartAttend requires 'Display over other apps' to lock attendance sessions and prevent proxy attendance.\n\n" +
                                        "📌 Android 13+ Security Step (Downloaded APK):\n" +
                                        "Because SmartAttend is installed as an APK, Android restricts special permissions by default.\n\n" +
                                        "Step 1: Tap '1. Open App Info' below.\n" +
                                        "Step 2: Tap the 3 DOTS (⋮) at top-right corner of App Info.\n" +
                                        "Step 3: Tap 'Allow restricted settings' and verify your Fingerprint or PIN.\n" +
                                        "Step 4: Return here and tap '2. Enable Overlay' to turn the switch ON.")
                            .setPositiveButton("1. Open App Info (3 Dots ⋮)", (dialog, which) -> {
                                try {
                                    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                                    intent.setData(Uri.parse("package:" + getPackageName()));
                                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                    startActivity(intent);
                                } catch (Exception ignored) {}
                            })
                            .setNeutralButton("2. Enable Overlay", (dialog, which) -> {
                                try {
                                    Intent intent = new Intent(
                                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                        Uri.parse("package:" + getPackageName())
                                    );
                                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                    startActivity(intent);
                                } catch (Exception e) {
                                    try {
                                        Intent fallback = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                                        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                        startActivity(fallback);
                                    } catch (Exception ignored) {}
                                }
                            })
                            .setNegativeButton("Close", (dialog, which) -> dialog.dismiss());
                    } else {
                        builder.setTitle("Permission: Display Over Other Apps")
                            .setMessage("SmartAttend requires 'Display over other apps' permission to activate Kiosk Lock Mode and secure your attendance sessions.\n\n" +
                                        "Instructions:\n" +
                                        "1. Tap 'Open Settings' below.\n" +
                                        "2. In the list that appears, find and tap 'SmartAttend'.\n" +
                                        "3. Turn ON the switch for 'Allow display over other apps'.\n" +
                                        "4. Tap your device's Back button to return to SmartAttend.")
                            .setPositiveButton("Open Settings", (dialog, which) -> {
                                try {
                                    Intent intent = new Intent(
                                        Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                        Uri.parse("package:" + getPackageName())
                                    );
                                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                    startActivity(intent);
                                } catch (Exception e) {
                                    try {
                                        Intent fallback = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
                                        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                        startActivity(fallback);
                                    } catch (Exception ignored) {}
                                }
                            })
                            .setNegativeButton("Later", (dialog, which) -> dialog.dismiss());
                    }
                    builder.setCancelable(true).show();
                    } catch (Throwable t) {
                        android.util.Log.e("MainActivity", "Error displaying overlay dialog", t);
                    }
                }, 1500);
            }
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
