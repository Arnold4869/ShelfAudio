package com.arnold.shelfaudio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * 音频播放前台服务
 *
 * 存在的唯一理由：Android 8+ 要求长时间后台播放必须有前台服务，
 * 否则系统会在 App 切后台几分钟内杀掉音频。@capgo/capacitor-native-audio
 * 只发 MediaSession 通知、不管理前台服务（官方文档明确说这是 App 的责任）。
 *
 * 本服务不做音频播放（播放仍由插件负责），只负责"占住前台"这个位置，
 * 让系统认为 App 在做用户可见的工作。
 */
public class PlaybackService extends Service {

    private static final String TAG = "ShelfAudioFg";
    private static final String CHANNEL_ID = "shelfaudio_playback";
    private static final int NOTIFICATION_ID = 8801;

    public static final String ACTION_START = "com.arnold.shelfaudio.START";
    public static final String ACTION_UPDATE = "com.arnold.shelfaudio.UPDATE";
    public static final String ACTION_STOP = "com.arnold.shelfaudio.STOP";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        try {
            if (ACTION_NOTIFICATION_MODE.equals(action)) {
                // 只切通知渠道的打扰级别，不动服务本身（后台播放照常）。
                String mode = intent != null ? intent.getStringExtra(EXTRA_NOTIF_MODE) : null;
                applyNotificationMode("quiet".equals(mode));
                return START_STICKY;
            }
            if (ACTION_STOP.equals(action)) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    stopForeground(true);
                } else {
                    stopForeground(true);
                }
                stopSelf();
                return START_NOT_STICKY;
            }

            String title = intent != null ? intent.getStringExtra(EXTRA_TITLE) : null;
            String text = intent != null ? intent.getStringExtra(EXTRA_TEXT) : null;
            if (title == null || title.isEmpty()) title = "听书";
            if (text == null || text.isEmpty()) text = "正在播放";

            createChannel();
            Notification n = buildNotification(title, text);

            // Android 14+ 必须在 startForeground 时声明服务类型，
            // 否则抛 MissingForegroundServiceTypeException 导致 App 崩溃。
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(NOTIFICATION_ID, n);
            }
        } catch (Throwable t) {
            // 前台服务里任何异常都不能崩掉 App
            Log.w(TAG, "onStartCommand 失败", t);
        }
        return START_STICKY;
    }

    /**
     * 通知渠道重要性。
     * normal → IMPORTANCE_LOW（在下拉栏可见，无声）
     * quiet  → IMPORTANCE_NONE（不显示，服务照常；Android 不允许前台服务无通知，
     *          所以这是能做到的"最静"档）
     * 用户如果自己在系统设置里改过渠道级别，这里不再覆盖（尊重用户）。
     */
    private void applyNotificationMode(boolean quiet) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch == null) {
            ch = new NotificationChannel(CHANNEL_ID, "后台播放",
                    quiet ? NotificationManager.IMPORTANCE_NONE : NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("听书在后台播放时的常驻通知（关闭后不影响播放与锁屏控制）");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } else {
            int want = quiet ? NotificationManager.IMPORTANCE_NONE : NotificationManager.IMPORTANCE_LOW;
            if (ch.getImportance() != want) {
                ch.setImportance(want);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            // 默认 LOW；若用户设过静默，下次 start 时由 applyNotificationMode 纠正
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "后台播放", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("听书在后台播放时的常驻通知（关闭后不影响播放与锁屏控制）");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String title, String text) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            piFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, open, piFlags);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .build();
    }

    @Override
    public void onDestroy() {
        try {
            stopForeground(true);
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
