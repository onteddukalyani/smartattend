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
        sInstance = this;
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
            
            mainHandler.postDelayed(() -> isReordering = false, 150);
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
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(this)) {
                if (KioskOverlayService.getInstance() != null) {
                    KioskOverlayService.getInstance().showOverlay();
                }
            }
        }
    }

    @Override
    public void onPause() {
        isPaused = true;
        super.onPause();
        if (KioskPlugin.isKioskEnforced) {
            bringToFront();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(this)) {
                if (KioskOverlayService.getInstance() != null) {
                    KioskOverlayService.getInstance().showOverlay();
                }
            }
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
                if (KioskOverlayService.getInstance() != null) {
                    KioskOverlayService.getInstance().hideOverlay();
                }
            } else {
                bringToFront();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(this)) {
                    if (KioskOverlayService.getInstance() != null) {
                        KioskOverlayService.getInstance().showOverlay();
                    }
                }
            }
        }
    }

    @Override
    public void onResume() {
        isPaused = false;
        super.onResume();
        if (KioskPlugin.isKioskEnforced) {
            KioskPlugin.reEnforceKiosk(this);
            if (KioskOverlayService.getInstance() != null) {
                KioskOverlayService.getInstance().hideOverlay();
            }
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
