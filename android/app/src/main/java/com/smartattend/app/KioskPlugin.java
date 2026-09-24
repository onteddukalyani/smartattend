package com.smartattend.app;

import android.accessibilityservice.AccessibilityServiceInfo;
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
import android.view.accessibility.AccessibilityManager;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Native Android Capacitor Kiosk / Lock Task Plugin for SmartAttend
 * 
 * Supports both:
 * 1. Dedicated Enterprise Device Owner / DevicePolicyManager mode (zero-prompt, un-escapable Lock Task, hardware restrictions).
 * 2. Unmanaged personal mode (Screen pinning, high-priority KioskWatchdogService, Accessibility Guardian, System Alert Overlay, sticky immersive fullscreen, FLAG_SECURE).
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
        
        JSObject ret = new JSObject();
        ret.put("isDeviceOwner", isOwner);
        ret.put("packageName", pkg);
        call.resolve(ret);
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
    public void canDrawOverlays(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        boolean canDraw = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            canDraw = Settings.canDrawOverlays(activity);
        }
        JSObject ret = new JSObject();
        ret.put("canDrawOverlays", canDraw);
        call.resolve(ret);
    }

    @PluginMethod
    public void requestOverlayPermission(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (!Settings.canDrawOverlays(activity)) {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + activity.getPackageName())
                );
                activity.startActivity(intent);
            }
        }
        JSObject ret = new JSObject();
        ret.put("requested", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void isAccessibilityServiceEnabled(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        boolean isEnabled = false;
        try {
            AccessibilityManager am = (AccessibilityManager) activity.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am != null) {
                List<AccessibilityServiceInfo> enabledServices = am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
                String expected = activity.getPackageName() + "/" + SmartAttendAccessibilityService.class.getName();
                for (AccessibilityServiceInfo info : enabledServices) {
                    if (info.getId() != null && info.getId().contains(activity.getPackageName())) {
                        isEnabled = true;
                        break;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "Accessibility check notice: " + e.getMessage());
        }
        JSObject ret = new JSObject();
        ret.put("isEnabled", isEnabled || SmartAttendAccessibilityService.isRunning());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestAccessibilityPermission(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Activity is null");
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            activity.startActivity(intent);
        } catch (Exception e) {
            Log.w(TAG, "Accessibility intent error: " + e.getMessage());
        }
        JSObject ret = new JSObject();
        ret.put("requested", true);
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

        boolean canOverlay = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            canOverlay = Settings.canDrawOverlays(activity);
        }

        boolean a11yActive = SmartAttendAccessibilityService.isRunning();

        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
        int lockTaskMode = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
            lockTaskMode = am.getLockTaskModeState();
        }

        JSObject ret = new JSObject();
        ret.put("isDeviceOwner", isOwner);
        ret.put("canDrawOverlays", canOverlay);
        ret.put("isAccessibilityActive", a11yActive);
        ret.put("isKioskEnforced", isKioskEnforced);
        ret.put("lockTaskModeState", lockTaskMode); // 0=NONE, 1=LOCKED (MDM), 2=PINNED (Screen Pin)
        ret.put("securityLevel", isOwner ? "HARDWARE_MDM_LOCK" : (canOverlay ? "ANTI_ESCAPE_OVERLAY_WATCHDOG" : "BASIC_SUPERVISION"));
        call.resolve(ret);
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
    public void stopKioskMode(PluginCall call) {
        stopKioskInternal(call);
    }

    @PluginMethod
    public void stopKiosk(PluginCall call) {
        stopKioskInternal(call);
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
                    ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isDeviceOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (isDeviceOwner) {
                        // 1. Whitelist SmartAttend for silent Lock Task mode
                        dpm.setLockTaskPackages(adminComponent, new String[]{ pkg });

                        // 2. Disable system status/notifications/home/recents in lock task mode
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            dpm.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                        }

                        // 3. Apply device restrictions to restrict unauthorized app/system access
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SAFE_BOOT);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_FACTORY_RESET);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_ADD_USER);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_APPS_CONTROL);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                        dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_USB_FILE_TRANSFER);

                        // Disable lockscreen / keyguard & status bar pull-down during attendance
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            dpm.setKeyguardDisabled(adminComponent, true);
                            dpm.setStatusBarDisabled(adminComponent, true);
                        }
                    }

                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("isDeviceOwner", isDeviceOwner);
                    ret.put("message", isDeviceOwner ? "Device Owner restrictions applied" : "Standard kiosk restrictions applied");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Exception setting attendance restrictions: " + e.getMessage(), e);
                    call.reject("Failed to set attendance restrictions: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error: " + e.getMessage(), e);
            call.reject("Error setting attendance restrictions: " + e.getMessage());
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
                    ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isDeviceOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (isDeviceOwner) {
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_SAFE_BOOT);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_FACTORY_RESET);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_ADD_USER);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_APPS_CONTROL);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                        dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_USB_FILE_TRANSFER);

                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            dpm.setKeyguardDisabled(adminComponent, false);
                            dpm.setStatusBarDisabled(adminComponent, false);
                        }
                    }

                    JSObject ret = new JSObject();
                    ret.put("success", true);
                    ret.put("message", "Attendance restrictions cleared successfully");
                    call.resolve(ret);
                } catch (Exception e) {
                    Log.e(TAG, "Exception clearing attendance restrictions: " + e.getMessage(), e);
                    call.reject("Failed to clear attendance restrictions: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error: " + e.getMessage(), e);
            call.reject("Error clearing attendance restrictions: " + e.getMessage());
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
                    isKioskEnforced = true;
                    
                    // 1. Start Watchdog Foreground Service
                    try {
                        Intent serviceIntent = new Intent(activity, KioskWatchdogService.class);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            ContextCompat.startForegroundService(activity, serviceIntent);
                        } else {
                            activity.startService(serviceIntent);
                        }
                    } catch (Exception svcErr) {
                        Log.w(TAG, "Watchdog service start notice: " + svcErr.getMessage());
                    }

                    // 2. Start Overlay Service if permission is granted
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && Settings.canDrawOverlays(activity)) {
                            Intent overlayIntent = new Intent(activity, KioskOverlayService.class);
                            overlayIntent.setAction("SHOW_BLOCKING_OVERLAY");
                            activity.startService(overlayIntent);
                        }
                    } catch (Exception overlayErr) {
                        Log.w(TAG, "Overlay service start notice: " + overlayErr.getMessage());
                    }

                    // 3. Re-enforce locks, screen wake, secure flags
                    reEnforceKiosk(activity);

                    DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                    ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                    String pkg = activity.getPackageName();
                    boolean isDeviceOwner = (dpm != null && dpm.isDeviceOwnerApp(pkg));

                    if (isDeviceOwner) {
                        try {
                            dpm.setLockTaskPackages(adminComponent, new String[]{ pkg });
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                                dpm.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                            }
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SAFE_BOOT);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_APPS_CONTROL);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_FACTORY_RESET);
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                dpm.setKeyguardDisabled(adminComponent, true);
                                dpm.setStatusBarDisabled(adminComponent, true);
                            }
                        } catch (Exception dpmErr) {
                            Log.w(TAG, "DPM config notice: " + dpmErr.getMessage());
                        }
                    }

                    // 4. Start Android OS Lock Task Mode (locks Home, Overview, and Notifications)
                    try {
                        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                            if (am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_NONE) {
                                activity.startLockTask();
                            }
                        } else {
                            activity.startLockTask();
                        }
                    } catch (Exception lockErr) {
                        Log.w(TAG, "startLockTask notice: " + lockErr.getMessage());
                    }

                    JSObject ret = new JSObject();
                    ret.put("active", true);
                    ret.put("isDeviceOwner", isDeviceOwner);
                    ret.put("flagSecure", true);
                    ret.put("message", isDeviceOwner ? "Managed Kiosk Mode active (Hardware Locked)" : "Kiosk Lock Task active (Guardian Protected)");
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

                    // 1. Stop Watchdog Foreground Service
                    try {
                        Intent serviceIntent = new Intent(activity, KioskWatchdogService.class);
                        activity.stopService(serviceIntent);
                    } catch (Exception svcErr) {
                        Log.w(TAG, "Stop service notice: " + svcErr.getMessage());
                    }

                    // 2. Stop Overlay Service
                    try {
                        Intent overlayIntent = new Intent(activity, KioskOverlayService.class);
                        overlayIntent.setAction("HIDE_BLOCKING_OVERLAY");
                        activity.stopService(overlayIntent);
                    } catch (Exception overlayErr) {
                        Log.w(TAG, "Stop overlay notice: " + overlayErr.getMessage());
                    }

                    // 3. Clear DevicePolicyManager restrictions
                    try {
                        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                        ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                        String pkg = activity.getPackageName();
                        if (dpm != null && dpm.isDeviceOwnerApp(pkg)) {
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_SAFE_BOOT);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_FACTORY_RESET);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_ADD_USER);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_APPS_CONTROL);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                            dpm.clearUserRestriction(adminComponent, UserManager.DISALLOW_USB_FILE_TRANSFER);
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                dpm.setKeyguardDisabled(adminComponent, false);
                                dpm.setStatusBarDisabled(adminComponent, false);
                            }
                        }
                    } catch (Exception e) {
                        Log.w(TAG, "Notice clearing DPM restrictions: " + e.getMessage());
                    }

                    // 4. Clear keep screen awake flag & clear screenshot block
                    Window window = activity.getWindow();
                    if (window != null) {
                        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED);
                        window.clearFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
                    }

                    // 5. Restore system UI
                    clearImmersiveMode(activity);

                    // 6. Exit Android Lock Task mode
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
     * Forcefully re-asserts Kiosk locks, screen wake, secure flag,
     * immersive sticky fullscreen, DevicePolicyManager restrictions, and lock task mode.
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

                    // 5. If Device Owner is provisioned, whitelist package & set restrictions
                    try {
                        DevicePolicyManager dpm = (DevicePolicyManager) activity.getSystemService(Context.DEVICE_POLICY_SERVICE);
                        ComponentName adminComponent = new ComponentName(activity, AdminReceiver.class);
                        String pkg = activity.getPackageName();
                        if (dpm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP && dpm.isDeviceOwnerApp(pkg)) {
                            dpm.setLockTaskPackages(adminComponent, new String[]{ pkg });
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                                dpm.setLockTaskFeatures(adminComponent, DevicePolicyManager.LOCK_TASK_FEATURE_NONE);
                            }
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SAFE_BOOT);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_FACTORY_RESET);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_ADD_USER);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_MOUNT_PHYSICAL_MEDIA);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_APPS_CONTROL);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS);
                            dpm.addUserRestriction(adminComponent, UserManager.DISALLOW_USB_FILE_TRANSFER);
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                                dpm.setKeyguardDisabled(adminComponent, true);
                                dpm.setStatusBarDisabled(adminComponent, true);
                            }
                        }
                    } catch (Exception dpmErr) {
                        Log.w(TAG, "DevicePolicyManager setup notice: " + dpmErr.getMessage());
                    }

                    // 6. Android Lock Task Mode (re-assert if not already locked)
                    try {
                        ActivityManager am = (ActivityManager) activity.getSystemService(Context.ACTIVITY_SERVICE);
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && am != null) {
                            int currentLockMode = am.getLockTaskModeState();
                            if (currentLockMode == ActivityManager.LOCK_TASK_MODE_NONE && isKioskEnforced) {
                                activity.startLockTask();
                            }
                        } else if (isKioskEnforced) {
                            activity.startLockTask();
                        }
                    } catch (Exception lockErr) {
                        Log.w(TAG, "Notice asserting Lock Task mode: " + lockErr.getMessage());
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
