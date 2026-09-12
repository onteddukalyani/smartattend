package com.smartattend.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native Android Capacitor Kiosk / Lock Task Plugin for SmartAttend
 * 
 * Manages zero-escape Android Lock Task mode for supervised attendance sessions:
 * - FLAG_SECURE: Prevents screenshots, screen recordings, and recents switcher thumbnails.
 * - IMMERSIVE STICKY: Hides status bar & navigation drawer to prevent app switching.
 * - On Device Owner / MDM managed devices: Uses DevicePolicyManager to whitelist lock task with zero confirmation prompts.
 * - On unmanaged consumer devices: Activates standard Android screen pinning gracefully with aggressive anti-tamper hooks.
 * - Screen Wake: Adds FLAG_KEEP_SCREEN_ON so student devices remain awake throughout the session.
 * - CAMERA SAFETY: Camera hardware remains 100% active for QR scanning & Biometric verification.
 */
@CapacitorPlugin(name = "KioskPlugin")
public class KioskPlugin extends Plugin {
    private static final String TAG = "SmartAttendKiosk";
    public static volatile boolean isKioskEnforced = false;

    @PluginMethod
    public void startKiosk(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    isKioskEnforced = true;
                    reEnforceKiosk(activity);

                    JSObject ret = new JSObject();
                    ret.put("active", true);
                    ret.put("flagSecure", true);
                    ret.put("message", "Zero-escape Kiosk Mode started successfully");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Exception starting Lock Task: " + e.getMessage(), e);
                    JSObject ret = new JSObject();
                    ret.put("active", false);
                    ret.put("error", e.getMessage());
                    ret.put("fallback", true);
                    call.resolve(ret);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error invoking startKiosk: " + e.getMessage(), e);
            call.reject("Error invoking startLockTask: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stopKiosk(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    isKioskEnforced = false;

                    // Clear keep screen awake flag & clear screenshot block
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);

                    // Restore system UI
                    clearImmersiveMode(activity);

                    ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                    boolean isLocked = true;

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                        isLocked = (am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE);
                    }

                    if (isLocked) {
                        Log.i(TAG, "Stopping Lock Task mode...");
                        activity.stopLockTask();
                    } else {
                        Log.i(TAG, "Lock Task mode was not active.");
                    }

                    JSObject ret = new JSObject();
                    ret.put("active", false);
                    ret.put("message", "Lock Task stopped successfully");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Exception stopping Lock Task: " + e.getMessage(), e);
                    JSObject ret = new JSObject();
                    ret.put("active", false);
                    ret.put("error", e.getMessage());
                    call.resolve(ret);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error invoking stopKiosk: " + e.getMessage(), e);
            call.reject("Error invoking stopLockTask: " + e.getMessage());
        }
    }

    @PluginMethod
    public void isKioskActive(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            JSObject ret = new JSObject();
            ret.put("active", false);
            call.resolve(ret);
            return;
        }

        try {
            ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
            DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
            boolean isLocked = false;
            int lockMode = 0;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                lockMode = am.getLockTaskModeState();
                isLocked = (lockMode != ActivityManager.LOCK_TASK_MODE_NONE);
            }

            boolean isDeviceOwner = false;
            if (dpm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR2) {
                isDeviceOwner = dpm.isDeviceOwnerApp(activity.getPackageName());
            }

            JSObject ret = new JSObject();
            ret.put("active", isLocked || isKioskEnforced);
            ret.put("mode", lockMode); // 0 = NONE, 1 = LOCKED (Device Owner MDM), 2 = PINNED (Standard screen pinning)
            ret.put("isManagedKiosk", lockMode == 1 || isDeviceOwner);
            ret.put("isDeviceOwner", isDeviceOwner);
            ret.put("isPinned", lockMode == 2);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Error checking Lock Task status: " + e.getMessage(), e);
            JSObject ret = new JSObject();
            ret.put("active", isKioskEnforced);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    /**
     * Static helper to forcefully re-assert Kiosk locks, screen wake, secure flag,
     * immersive sticky fullscreen, and lock task mode whenever focus or gesture events occur.
     */
    public static void reEnforceKiosk(Activity activity) {
        if (activity == null || !isKioskEnforced) return;

        try {
            activity.runOnUiThread(() -> {
                try {
                    Window window = activity.getWindow();
                    if (window != null) {
                        // 1. Keep screen alive
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        // 2. Block screenshots, screen recording, and recents thumbnail snooping
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                        // 3. Keep on top of lockscreen
                        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                        window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                    }

                    // 4. Apply sticky immersive fullscreen
                    applyImmersiveMode(activity);

                    // 5. If Device Owner is provisioned, whitelist package in DevicePolicyManager
                    try {
                        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                        ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                        String pkg = activity.getPackageName();
                        if (dpm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && dpm.isDeviceOwnerApp(pkg)) {
                            dpm.setLockTaskPackages(adminComponent, new String[]{ pkg });
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                                dpm.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                            }
                        }
                    } catch (Exception dpmErr) {
                        Log.w(TAG, "DevicePolicyManager setup notice: " + dpmErr.getMessage());
                    }

                    // 6. Android Lock Task Mode (Screen Pinning / Dedicated Kiosk)
                    ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                        int currentLockMode = am.getLockTaskModeState();
                        if (currentLockMode == ActivityManager.LOCK_TASK_MODE_NONE && isKioskEnforced) {
                            Log.i(TAG, "Re-asserting Lock Task mode...");
                            activity.startLockTask();
                        }
                    }
                } catch (Exception e) {
                    Log.w(TAG, "reEnforceKiosk internal error: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.w(TAG, "reEnforceKiosk dispatch error: " + e.getMessage());
        }
    }

    public static void applyImmersiveMode(Activity activity) {
        if (activity == null) return;
        Window window = activity.getWindow();
        if (window == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                controller.hide(WindowInsetsCompat.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            View decorView = window.getDecorView();
            decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
            );
        }
    }

    public static void clearImmersiveMode(Activity activity) {
        if (activity == null) return;
        Window window = activity.getWindow();
        if (window == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowCompat.setDecorFitsSystemWindows(window, true);
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                controller.show(WindowInsetsCompat.Type.systemBars());
            }
        } else {
            View decorView = window.getDecorView();
            decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }
}

