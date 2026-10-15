package com.smartattend.app;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * SmartAttend Native Android Notification Plugin
 * 
 * Provides real OS-level heads-up notifications, notification channels,
 * status bar icons, vibration patterns, and tap-to-open pending intents.
 */
@CapacitorPlugin(name = "NativeNotificationPlugin")
public class NativeNotificationPlugin extends Plugin {

    public static final String PRIMARY_CHANNEL_ID = "smartattend_alerts_channel";
    public static final String PRIMARY_CHANNEL_NAME = "SmartAttend Alerts";
    public static final String PRIMARY_CHANNEL_DESC = "Real-time attendance sessions, announcements, and security alerts";

    @Override
    public void load() {
        super.load();
        createNotificationChannels();
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Context context = getContext();
            NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                NotificationChannel channel = new NotificationChannel(
                    PRIMARY_CHANNEL_ID,
                    PRIMARY_CHANNEL_NAME,
                    NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription(PRIMARY_CHANNEL_DESC);
                channel.enableLights(true);
                channel.setLightColor(Color.parseColor("#4F46E5")); // Indigo accent
                channel.enableVibration(true);
                channel.setVibrationPattern(new long[]{0, 200, 100, 200});
                channel.setShowBadge(true);

                Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                AudioAttributes audioAttributes = new AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .build();
                channel.setSound(defaultSoundUri, audioAttributes);

                manager.createNotificationChannel(channel);
            }
        }
    }

    @PluginMethod
    public void requestPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= 33) { // Android 13+ Tiramisu
            Context context = getContext();
            boolean hasPermission = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;

            if (hasPermission) {
                ret.put("granted", true);
                call.resolve(ret);
            } else if (getActivity() != null) {
                ActivityCompat.requestPermissions(
                    getActivity(),
                    new String[]{Manifest.permission.POST_NOTIFICATIONS},
                    101
                );
                ret.put("requested", true);
                ret.put("granted", false);
                call.resolve(ret);
            } else {
                ret.put("granted", false);
                call.resolve(ret);
            }
        } else {
            ret.put("granted", true);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void showNotification(PluginCall call) {
        String title = call.getString("title", "SmartAttend Notice");
        String body = call.getString("body", "");
        String type = call.getString("type", "GENERAL");
        int notificationId = call.getInt("id", (int) (System.currentTimeMillis() % 100000));

        Context context = getContext();
        if (context == null) {
            call.reject("Android Context unavailable");
            return;
        }

        // Check permission on Android 13+
        if (Build.VERSION.SDK_INT >= 33) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                JSObject ret = new JSObject();
                ret.put("success", false);
                ret.put("reason", "Notification permission not granted");
                call.resolve(ret);
                return;
            }
        }

        try {
            createNotificationChannels();

            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            intent.putExtra("from_notification", true);
            intent.putExtra("notification_id", notificationId);
            intent.putExtra("notification_type", type);

            int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pendingIntent = PendingIntent.getActivity(context, notificationId, intent, pendingFlags);

            int smallIconRes = context.getApplicationInfo().icon;
            if (smallIconRes == 0) {
                smallIconRes = android.R.drawable.ic_dialog_info;
            }

            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

            NotificationCompat.Builder builder = new NotificationCompat.Builder(context, PRIMARY_CHANNEL_ID)
                .setSmallIcon(smallIconRes)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setAutoCancel(true)
                .setSound(soundUri)
                .setVibrate(new long[]{0, 200, 100, 200})
                .setColor(Color.parseColor("#4F46E5"))
                .setContentIntent(pendingIntent);

            NotificationManagerCompat manager = NotificationManagerCompat.from(context);
            manager.notify(notificationId, builder.build());

            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("id", notificationId);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to display native notification: " + e.getMessage());
        }
    }
}
