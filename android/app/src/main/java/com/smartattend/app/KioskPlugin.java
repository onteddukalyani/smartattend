package com.smartattend.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.view.WindowManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Native Android Capacitor Kiosk / Lock Task Plugin for SmartAttend
 * 
 * Manages Android Lock Task mode for supervised attendance sessions:
 * - On MDM / Device Owner managed devices: Enforces true zero-escape dedicated Lock Task.
 * - On unmanaged consumer devices: Activates standard Android screen pinning gracefully.
 * - Screen Wake: Adds FLAG_KEEP_SCREEN_ON so student devices remain awake throughout the session.
 * - CAMERA SAFETY: Camera hardware remains 100% active for QR scanning & Biometric verification.
 */
@CapacitorPlugin(name = "KioskPlugin")
public class KioskPlugin extends Plugin {
    private static final String TAG = "SmartAttendKiosk";

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
                    // 1. Keep screen alive so phone doesn't sleep during the 3-minute session
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

                    ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                    boolean isLocked = false;
                    int currentLockMode = 0;

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                        currentLockMode = am.getLockTaskModeState();
                        isLocked = (currentLockMode != ActivityManager.LOCK_TASK_MODE_NONE);
                    }

                    if (!isLocked) {
                        Log.i(TAG, "Starting Lock Task mode for SmartAttend...");
                        activity.startLockTask();
                    } else {
                        Log.i(TAG, "Lock Task mode already active (mode: " + currentLockMode + ").");
                    }

                    JSObject ret = new JSObject();
                    ret.put("active", true);
                    ret.put("mode", currentLockMode);
                    ret.put("message", "Lock Task started successfully");
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
                    // Clear keep screen awake flag
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

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
            boolean isLocked = false;
            int lockMode = 0;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                lockMode = am.getLockTaskModeState();
                isLocked = (lockMode != ActivityManager.LOCK_TASK_MODE_NONE);
            }

            JSObject ret = new JSObject();
            ret.put("active", isLocked);
            ret.put("mode", lockMode); // 0 = NONE, 1 = LOCKED (Device Owner MDM), 2 = PINNED (Standard screen pinning)
            ret.put("isManagedKiosk", lockMode == 1);
            ret.put("isPinned", lockMode == 2);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "Error checking Lock Task status: " + e.getMessage(), e);
            JSObject ret = new JSObject();
            ret.put("active", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }
}
