package com.smartattend.app;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.UserManager;
import android.provider.Settings;
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
 * True Android Enterprise Kiosk / Lock Task Plugin for SmartAttend.
 * 
 * Enforces hardware-level dedicated Lock Task Mode via DevicePolicyManager (Device Owner).
 * Strictly rejects and blocks Screen Pinning fallback if the device is not provisioned as Device Owner.
 */
@CapacitorPlugin(name = "KioskPlugin")
public class KioskPlugin extends Plugin {
    private static final String TAG = "SmartAttendKiosk";
    public static volatile boolean isKioskEnforced = false;

    @PluginMethod
    public void isDeviceOwner(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
        String pkg = activity.getPackageName();
        boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

        Log.d("SmartAttend", "DeviceOwner=" + isOwner);

        JSObject ret = new JSObject();
        ret.put("isDeviceOwner", isOwner);
        ret.put("packageName", pkg);
        call.resolve(ret);
    }

    public static String getLockTaskStateString(int state) {
        switch (state) {
            case ActivityManager.LOCK_TASK_MODE_LOCKED:
                return "LOCK_TASK_MODE_LOCKED";
            case ActivityManager.LOCK_TASK_MODE_PINNED:
                return "LOCK_TASK_MODE_PINNED";
            case ActivityManager.LOCK_TASK_MODE_NONE:
            default:
                return "LOCK_TASK_MODE_NONE";
        }
    }

    @PluginMethod
    public void getDeviceIdentity(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        String androidId = Settings.Secure.getString(activity.getContentResolver(), Settings.Secure.ANDROID_ID);
        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
        String pkg = activity.getPackageName();
        boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

        JSObject ret = new JSObject();
        ret.put("deviceId", (androidId != null && !androidId.isEmpty()) ? androidId : "DEVICE_" + Build.MODEL);
        ret.put("model", Build.MODEL);
        ret.put("manufacturer", Build.MANUFACTURER);
        ret.put("sdkVersion", Build.VERSION.SDK_INT);
        ret.put("isDeviceOwner", isOwner);
        call.resolve(ret);
    }

    @PluginMethod
    public void getSecurityDiagnostics(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
        String pkg = activity.getPackageName();
        boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
        int lockTaskMode = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
            lockTaskMode = am.getLockTaskModeState();
        }

        JSObject ret = new JSObject();
        ret.put("isDeviceOwner", isOwner);
        ret.put("isKioskEnforced", isKioskEnforced);
        ret.put("lockTaskModeState", lockTaskMode); // 0 = NONE, 1 = LOCKED (Device Owner Lock Task), 2 = PINNED (Screen Pin)
        ret.put("securityLevel", isOwner ? "DEVICE_OWNER_LOCK_TASK" : "UNENROLLED_PERSONAL_DEVICE");
        call.resolve(ret);
    }

    @PluginMethod
    public void setAttendanceRestrictions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    ComponentName admin = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (!isOwner) {
                        JSObject ret = new JSObject();
                        ret.put("success", false);
                        ret.put("isDeviceOwner", false);
                        ret.put("error", "NOT_DEVICE_OWNER");
                        ret.put("message", "Device is not provisioned as Device Owner.");
                        call.resolve(ret);
                        return;
                    }

                    // 1. Whitelist SmartAttend package for dedicated Lock Task Mode
                    dpm.setLockTaskPackages(admin, new String[]{ pkg });

                    // 2. Disable system status, notifications, home, overview, and quick settings
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                    }

                    // 3. Disable status bar pull-down and keyguard
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        dpm.setStatusBarDisabled(admin, true);
                        dpm.setKeyguardDisabled(admin, true);
                    }

                    // 4. Add enterprise hardware restrictions
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);

                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("isDeviceOwner", true);
                    ret.put("message", "True Device Owner attendance restrictions applied.");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Error applying attendance restrictions: " + e.getMessage(), e);
                    call.reject("Failed to apply attendance restrictions: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error setting restrictions: " + e.getMessage(), e);
            call.reject("Error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void clearAttendanceRestrictions(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    ComponentName admin = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (isOwner) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            dpm.setStatusBarDisabled(admin, false);
                            dpm.setKeyguardDisabled(admin, false);
                        }

                        dpm.clearUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT);
                        dpm.clearUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL);
                        dpm.clearUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET);
                        dpm.clearUserRestriction(admin, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                    }

                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("message", "Device restrictions cleared.");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Error clearing restrictions: " + e.getMessage(), e);
                    call.reject("Failed to clear restrictions: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            call.reject("Error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void startLockTask(PluginCall call) {
        startKioskInternal(call);
    }

    @PluginMethod
    public void startKioskMode(PluginCall call) {
        startKioskInternal(call);
    }

    @PluginMethod
    public void startKiosk(PluginCall call) {
        startKioskInternal(call);
    }

    @PluginMethod
    public void stopLockTask(PluginCall call) {
        stopKioskInternal(call);
    }

    @PluginMethod
    public void stopKioskMode(PluginCall call) {
        stopKioskInternal(call);
    }

    @PluginMethod
    public void stopKiosk(PluginCall call) {
        stopKioskInternal(call);
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
                isLocked = (lockMode == ActivityManager.LOCK_TASK_MODE_LOCKED);
            }

            boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(activity.getPackageName()));

            JSObject ret = new JSObject();
            ret.put("active", isLocked || (isKioskEnforced && isOwner));
            ret.put("mode", lockMode); // 1 = LOCKED (Enterprise MDM), 2 = PINNED (Screen Pin), 0 = NONE
            ret.put("isManagedKiosk", lockMode == ActivityManager.LOCK_TASK_MODE_LOCKED || isOwner);
            ret.put("isDeviceOwner", isOwner);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("active", isKioskEnforced);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    private void startKioskInternal(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    String pkg = activity.getPackageName();
                    ComponentName admin = new ComponentName(activity, AdminReceiver.class);

                    // STRICT VERIFICATION: Verify Device Owner before entering kiosk
                    boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));
                    Log.d("SmartAttend", "DeviceOwner=" + (dpm != null && dpm.isDeviceOwnerApp(pkg)));

                    if (!isOwner) {
                        Log.e(TAG, "Device is NOT enrolled as Device Owner! Aborting Lock Task to prevent Screen Pinning fallback.");
                        JSObject ret = new JSObject();
                        ret.put("active", false);
                        ret.put("isDeviceOwner", false);
                        ret.put("error", "NOT_DEVICE_OWNER");
                        ret.put("message", "Device is not provisioned as a Device Owner. True Enterprise Lock Task Mode cannot be started.");
                        call.resolve(ret);
                        return;
                    }

                    // 1. Keep screen alive & block screenshots with FLAG_SECURE
                    Window window = activity.getWindow();
                    if (window != null) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                        window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                    }

                    // 2. Configure Enterprise DevicePolicyManager settings
                    dpm.setLockTaskPackages(admin, new String[]{ pkg });

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                    }

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        dpm.setStatusBarDisabled(admin, true);
                        dpm.setKeyguardDisabled(admin, true);
                    }

                    dpm.addUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET);
                    dpm.addUserRestriction(admin, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);

                    // 3. Apply immersive sticky fullscreen
                    applyImmersiveMode(activity);

                    // 4. Start TRUE Device Owner Lock Task Mode (Zero user prompt, inescapable)
                    isKioskEnforced = true;
                    activity.startLockTask();

                    ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                    int lockTaskState = 0;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                        lockTaskState = am.getLockTaskModeState();
                    }
                    Log.d("SmartAttend", "LockTaskState=" + getLockTaskStateString(lockTaskState));

                    JSObject ret = new JSObject();
                    ret.put("active", true);
                    ret.put("isDeviceOwner", true);
                    ret.put("lockTaskState", getLockTaskStateString(lockTaskState));
                    ret.put("flagSecure", true);
                    ret.put("message", "True Device Owner Lock Task Mode activated successfully.");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Exception starting Lock Task: " + e.getMessage(), e);
                    JSObject ret = new JSObject();
                    ret.put("active", false);
                    ret.put("error", e.getMessage());
                    call.resolve(ret);
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error invoking startKiosk: " + e.getMessage(), e);
            call.reject("Error invoking startLockTask: " + e.getMessage());
        }
    }

    private void stopKioskInternal(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }

        try {
            activity.runOnUiThread(() -> {
                try {
                    isKioskEnforced = false;

                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    ComponentName admin = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    // 1. Restore status bar, keyguard, and user restrictions
                    if (isOwner) {
                        try {
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                dpm.setStatusBarDisabled(admin, false);
                                dpm.setKeyguardDisabled(admin, false);
                            }

                            dpm.clearUserRestriction(admin, UserManager.DISALLOW_SAFE_BOOT);
                            dpm.clearUserRestriction(admin, UserManager.DISALLOW_APPS_CONTROL);
                            dpm.clearUserRestriction(admin, UserManager.DISALLOW_FACTORY_RESET);
                            dpm.clearUserRestriction(admin, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                        } catch (Exception e) {
                            Log.w(TAG, "Notice clearing restrictions: " + e.getMessage());
                        }
                    }

                    // 2. Clear window flags
                    Window window = activity.getWindow();
                    if (window != null) {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                    }

                    // 3. Restore system UI
                    clearImmersiveMode(activity);

                    // 4. Exit Android Lock Task mode
                    try {
                        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                        boolean isLocked = true;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                            isLocked = (am.getLockTaskModeState() != ActivityManager.LOCK_TASK_MODE_NONE);
                        }

                        if (isLocked) {
                            activity.stopLockTask();
                        }
                    } catch (Exception lockErr) {
                        Log.w(TAG, "Notice stopping lock task: " + lockErr.getMessage());
                    }

                    JSObject ret = new JSObject();
                    ret.put("active", false);
                    ret.put("message", "Lock Task stopped and normal device access restored.");
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

    /**
     * Re-asserts Lock Task Mode & window flags if enforced.
     */
    public static void reEnforceKiosk(Activity activity) {
        if (activity == null || !isKioskEnforced) return;

        try {
            activity.runOnUiThread(() -> {
                try {
                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    String pkg = activity.getPackageName();
                    boolean isOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (!isOwner) return;

                    Window window = activity.getWindow();
                    if (window != null) {
                        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE);
                        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                        window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                    }

                    applyImmersiveMode(activity);

                    ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                        int lockMode = am.getLockTaskModeState();
                        if (lockMode == ActivityManager.LOCK_TASK_MODE_NONE && isKioskEnforced) {
                            activity.startLockTask();
                        }
                    }
                } catch (Exception ignored) {}
            });
        } catch (Exception ignored) {}
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
