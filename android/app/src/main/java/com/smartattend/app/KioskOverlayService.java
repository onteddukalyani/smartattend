package com.smartattend.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * System Alert Window Blocking Overlay for SmartAttend Kiosk Mode.
 * 
 * When active (isKioskEnforced == true), if a student minimizes or leaves SmartAttend:
 * 1. Immediately displays a full-screen, touch-blocking overlay over the entire screen.
 * 2. Blocks interaction with launchers, settings, notifications, or other apps.
 * 3. Immediately triggers MainActivity to resume full-screen foreground.
 */
public class KioskOverlayService extends Service {
    private static final String TAG = "SmartAttendOverlay";
    private static KioskOverlayService sInstance = null;

    private WindowManager windowManager;
    private View overlayView;
    private boolean isOverlayShowing = false;
    private final Handler handler = new Handler(Looper.getMainLooper());

    public static KioskOverlayService getInstance() {
        return sInstance;
    }

    public static boolean isRunning() {
        return sInstance != null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        windowManager = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!KioskPlugin.isKioskEnforced) {
            hideOverlay();
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = (intent != null) ? intent.getAction() : null;
        if ("SHOW_BLOCKING_OVERLAY".equals(action)) {
            showOverlay();
        } else if ("HIDE_BLOCKING_OVERLAY".equals(action)) {
            hideOverlay();
        }

        return START_STICKY;
    }

    public void showOverlay() {
        if (!KioskPlugin.isKioskEnforced) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            Log.w(TAG, "Cannot draw overlay: SYSTEM_ALERT_WINDOW permission not granted.");
            return;
        }

        handler.post(() -> {
            try {
                if (overlayView == null) {
                    overlayView = createOverlayView();
                }

                if (!isOverlayShowing && overlayView != null && windowManager != null) {
                    int layoutType;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        layoutType = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
                    } else {
                        layoutType = WindowManager.LayoutParams.TYPE_PHONE;
                    }

                    WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.MATCH_PARENT,
                        layoutType,
                        WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                            | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_FULLSCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                        PixelFormat.TRANSLUCENT
                    );
                    params.gravity = Gravity.CENTER;

                    windowManager.addView(overlayView, params);
                    isOverlayShowing = true;
                    Log.i(TAG, "Blocking Kiosk Overlay displayed.");
                }

                // Immediately pull MainActivity to foreground
                if (MainActivity.getInstance() != null) {
                    MainActivity.getInstance().bringToFront();
                }
            } catch (Exception e) {
                Log.e(TAG, "Error displaying overlay: " + e.getMessage());
            }
        });
    }

    public void hideOverlay() {
        handler.post(() -> {
            try {
                if (isOverlayShowing && overlayView != null && windowManager != null) {
                    windowManager.removeView(overlayView);
                    isOverlayShowing = false;
                    Log.i(TAG, "Blocking Kiosk Overlay removed.");
                }
            } catch (Exception e) {
                Log.w(TAG, "Notice removing overlay: " + e.getMessage());
            }
        });
    }

    private View createOverlayView() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setBackgroundColor(Color.parseColor("#E60F172A")); // Deep dark blue-slate with high opacity
        layout.setPadding(48, 48, 48, 48);

        TextView iconView = new TextView(this);
        iconView.setText("🔒");
        iconView.setTextSize(48);
        iconView.setGravity(Gravity.CENTER);
        layout.addView(iconView);

        TextView titleView = new TextView(this);
        titleView.setText("SmartAttend Kiosk Active");
        titleView.setTextSize(22);
        titleView.setTextColor(Color.WHITE);
        titleView.setTypeface(null, android.graphics.Typeface.BOLD);
        titleView.setGravity(Gravity.CENTER);
        titleView.setPadding(0, 24, 0, 12);
        layout.addView(titleView);

        TextView messageView = new TextView(this);
        messageView.setText("Your attendance session is locked and strictly supervised.\nSwitching apps or leaving SmartAttend is not permitted.");
        messageView.setTextSize(14);
        messageView.setTextColor(Color.parseColor("#94A3B8"));
        messageView.setGravity(Gravity.CENTER);
        messageView.setPadding(0, 0, 0, 32);
        layout.addView(messageView);

        Button resumeButton = new Button(this);
        resumeButton.setText("Return to SmartAttend");
        resumeButton.setTextColor(Color.WHITE);
        resumeButton.setBackgroundColor(Color.parseColor("#4F46E5")); // Indigo
        resumeButton.setPadding(32, 16, 32, 16);
        resumeButton.setOnClickListener(v -> {
            if (MainActivity.getInstance() != null) {
                MainActivity.getInstance().bringToFront();
            } else {
                Intent intent = new Intent(this, MainActivity.class);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
                startActivity(intent);
            }
            hideOverlay();
        });
        layout.addView(resumeButton);

        layout.setOnClickListener(v -> {
            if (MainActivity.getInstance() != null) {
                MainActivity.getInstance().bringToFront();
            }
            hideOverlay();
        });

        return layout;
    }

    @Override
    public void onDestroy() {
        hideOverlay();
        sInstance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
