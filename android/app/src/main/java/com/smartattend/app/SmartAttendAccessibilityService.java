package com.smartattend.app;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;

/**
 * Accessibility Guardian Service for SmartAttend.
 * 
 * Provides continuous background protection during active attendance kiosk sessions:
 * 1. Detects window state transitions across the entire OS (TYPE_WINDOW_STATE_CHANGED).
 * 2. If any other application (launcher, settings, social media, split-screen) is brought to the foreground
 *    while an attendance session is active (KioskPlugin.isKioskEnforced == true),
 *    this service instantly re-launches SmartAttend MainActivity.
 * 3. Intercepts hardware & navigation keys (KEYCODE_APP_SWITCH, KEYCODE_HOME, etc.) to block app switching.
 */
public class SmartAttendAccessibilityService extends AccessibilityService {
    private static final String TAG = "SmartAttendA11y";
    private static SmartAttendAccessibilityService sInstance = null;

    public static SmartAttendAccessibilityService getInstance() {
        return sInstance;
    }

    public static boolean isRunning() {
        return sInstance != null;
    }

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        Log.i(TAG, "SmartAttend Accessibility Guardian Service connected.");

        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED | AccessibilityEvent.TYPE_WINDOWS_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS 
            | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS 
            | AccessibilityServiceInfo.FLAG_REQUEST_FILTER_KEY_EVENTS;
        info.notificationTimeout = 50;
        setServiceInfo(info);
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        if (KioskPlugin.isKioskEnforced) {
            int keyCode = event.getKeyCode();
            // Block Recents / App Switcher, Home, and Back navigation across the entire OS
            if (keyCode == KeyEvent.KEYCODE_APP_SWITCH 
                || keyCode == KeyEvent.KEYCODE_HOME 
                || keyCode == KeyEvent.KEYCODE_BACK
                || keyCode == KeyEvent.KEYCODE_WINDOW
                || keyCode == KeyEvent.KEYCODE_ALL_APPS) {
                Log.d(TAG, "Blocked system navigation key: " + keyCode);
                relaunchMainActivity();
                return true; // Consume event completely
            }
        }
        return super.onKeyEvent(event);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!KioskPlugin.isKioskEnforced) {
            return;
        }

        if (event == null) return;

        int eventType = event.getEventType();
        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            CharSequence packageNameSeq = event.getPackageName();
            if (packageNameSeq != null) {
                String topPackage = packageNameSeq.toString();
                String ourPackage = getPackageName();

                // If the foreground window belongs to another app or system UI (except SmartAttend)
                if (!ourPackage.equals(topPackage)) {
                    Log.w(TAG, "Unauthorized window change detected: " + topPackage + ". Re-asserting SmartAttend Kiosk...");
                    relaunchMainActivity();
                }
            }
        }
    }

    public void relaunchMainActivity() {
        if (!KioskPlugin.isKioskEnforced) return;

        try {
            Intent intent = new Intent(this, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK 
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT 
                | Intent.FLAG_ACTIVITY_SINGLE_TOP 
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            startActivity(intent);
        } catch (Exception e) {
            Log.e(TAG, "Error relaunching MainActivity from Accessibility: " + e.getMessage());
        }
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "Accessibility Guardian interrupted.");
    }

    @Override
    public void onDestroy() {
        sInstance = null;
        super.onDestroy();
    }
}
