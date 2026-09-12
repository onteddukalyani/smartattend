package com.smartattend.app;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.Toast;

/**
 * Device Admin Receiver for SmartAttend Kiosk & Lock Task Mode.
 * Enables zero-prompt dedicated Lock Task mode when configured as Device Owner via ADB/MDM.
 */
public class AdminReceiver extends DeviceAdminReceiver {
    private static final String TAG = "SmartAttendAdmin";

    @Override
    public void onEnabled(Context context, Intent intent) {
        super.onEnabled(context, intent);
        Log.i(TAG, "SmartAttend Device Admin Enabled");
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        super.onDisabled(context, intent);
        Log.i(TAG, "SmartAttend Device Admin Disabled");
    }

    @Override
    public void onLockTaskModeEntering(Context context, Intent intent, String pkg) {
        super.onLockTaskModeEntering(context, intent, pkg);
        Log.i(TAG, "Entering dedicated Lock Task Kiosk mode for: " + pkg);
    }

    @Override
    public void onLockTaskModeExiting(Context context, Intent intent) {
        super.onLockTaskModeExiting(context, intent);
        Log.i(TAG, "Exited Lock Task Kiosk mode");
    }
}
