package com.smartattend.app;

import android.app.ActivityManager;
import android.app.ActivityOptions;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import java.lang.reflect.Method;

/**
 * High-Priority Foreground Watchdog Service for SmartAttend Kiosk Lock Mode.
 * 
 * Guarantees that while an attendance session is active (isKioskEnforced == true):
 * 1. SmartAttend MainActivity is immediately pulled back to full-screen foreground via multiple vectors:
 *    - FullScreenIntent High-Priority Alarm/Call Notification (bypasses Android 10-15 BAL restrictions)
 *    - SmartAttendAccessibilityService window transition interception
 *    - KioskOverlayService blocking system overlay
 * 2. System notification shades and dialogs are continuously closed.
 * 3. Android Lock Task / Pinning mode is re-asserted if dropped.
 */
public class KioskWatchdogService extends Service {
    private static final String TAG = "SmartAttendWatchdog";
    private static final String CHANNEL_ID = "smartattend_kiosk_guard_channel";
    private static final int NOTIFICATION_ID = 9999;
    
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean isRunning = false;

    private final Runnable watchdogTask = new Runnable() {
        @Override
        public void run() {
            if (!KioskPlugin.isKioskEnforced) {
                stopSelf();
                return;
            }

            try {
                enforceForeground();
                collapseSystemShades();
            } catch (Exception e) {
                Log.w(TAG, "Watchdog loop notice: " + e.getMessage());
            }

            if (isRunning) {
                handler.postDelayed(this, 500); // Gentle 500ms check (smooth, zero UI stutter)
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForegroundServiceNotification();
        isRunning = true;
        handler.post(watchdogTask);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundServiceNotification();
        if (!isRunning) {
            isRunning = true;
            handler.post(watchdogTask);
        }
        return START_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "SmartAttend Kiosk Security Guardian",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Maintains locked attendance session integrity");
            channel.setShowBadge(false);
            channel.setSound(null, null);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void startForegroundServiceNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        notificationIntent.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, flags);

        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("SmartAttend Session Lock Active")
            .setContentText("Attendance session is supervised and locked in Kiosk Mode")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentIntent(pendingIntent)
            .setFullScreenIntent(pendingIntent, true) // High priority full-screen trigger
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .build();

        startForeground(NOTIFICATION_ID, notification);
    }

    private void enforceForeground() {
        if (!KioskPlugin.isKioskEnforced) return;

        try {
            MainActivity activity = MainActivity.getInstance();
            boolean isPaused = (activity == null || activity.isActivityPaused());

            if (isPaused) {
                // 1. Trigger Accessibility Service relaunch if running
                if (SmartAttendAccessibilityService.isRunning()) {
                    SmartAttendAccessibilityService.getInstance().relaunchMainActivity();
                }

                // 2. Launch MainActivity via PendingIntent with Android 14/15 BAL Bypass
                Intent launchIntent = new Intent(this, MainActivity.class);
                launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK 
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT 
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                
                int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
                }
                
                Bundle options = null;
                if (Build.VERSION.SDK_INT >= 34) {
                    try {
                        ActivityOptions actOpts = ActivityOptions.makeBasic();
                        Method method = ActivityOptions.class.getMethod("setPendingIntentBackgroundActivityStartMode", int.class);
                        method.invoke(actOpts, 1); // MODE_BACKGROUND_ACTIVITY_START_ALLOWED = 1
                        options = actOpts.toBundle();
                    } catch (Exception ignored) {}
                }

                PendingIntent pi = PendingIntent.getActivity(this, 0, launchIntent, pendingFlags);
                try {
                    if (options != null) {
                        pi.send(this, 0, null, null, null, null, options);
                    } else {
                        pi.send();
                    }
                } catch (Exception e) {
                    try {
                        startActivity(launchIntent, options);
                    } catch (Exception ignored) {}
                }

                // 3. If MainActivity exists, call bringToFront()
                if (activity != null) {
                    activity.bringToFront();
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "enforceForeground error: " + e.getMessage());
        }
    }

    private void collapseSystemShades() {
        try {
            // Close system dialogs / notification pulls
            Intent closeDialogs = new Intent(Intent.ACTION_CLOSE_SYSTEM_DIALOGS);
            sendBroadcast(closeDialogs);
        } catch (Exception ignored) {}

        try {
            Object statusBarService = getSystemService("statusbar");
            if (statusBarService != null) {
                Class<?> statusBarManager = Class.forName("android.app.StatusBarManager");
                Method collapse = statusBarManager.getMethod("collapsePanels");
                collapse.invoke(statusBarService);
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onDestroy() {
        isRunning = false;
        handler.removeCallbacks(watchdogTask);
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
