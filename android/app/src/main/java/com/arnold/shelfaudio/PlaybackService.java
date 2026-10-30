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
    // 老板 2026-09-13：可关"普通通知"但保留锁屏控制（插件 MediaStyle 那条不动）。
    public static final String ACTION_NOTIFICATION_MODE = "com.arnold.shelfaudio.NOTIF_MODE";
    public static final String EXTRA_NOTIF_MODE = "mode";   // "normal" | "quiet"
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_TEXT = "text";

    // 「上次由 App 写入的通知模式」——applyNotificationMode 用它区分
    // 「级别还是我们写的」与「用户在系统设置里改过」（后者不覆盖）。
    private static final String NOTIF_PREFS = "shelfaudio_playback";
    private static final String PREF_LAST_MODE = "notif_mode";   // "normal" | "quiet"

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY 的服务被系统杀掉后重启时 intent == null —— 此时播放早已不在，
        // 重新走 START 分支会凭空拉起常驻通知。视为「重启即退出」。
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        try {
            if (ACTION_NOTIFICATION_MODE.equals(action)) {
                // 只切通知渠道的打扰级别，不动服务本身（后台播放照常）。
                String mode = intent.getStringExtra(EXTRA_NOTIF_MODE);
                applyNotificationMode("quiet".equals(mode));
                return START_STICKY;
            }
            if (ACTION_STOP.equals(action)) {
                // minSdk=24，STOP_FOREGROUND_REMOVE 全版本可用（boolean 版在 API 33 已弃用；
                // 原先 if/else 两个分支调用完全相同，属死分支）。
                stopForeground(STOP_FOREGROUND_REMOVE);
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
     * 通知渠道重要性（实例版转发，保持 Service 内原调用点不变）。
     */
    private void applyNotificationMode(boolean quiet) {
        applyNotificationMode(this, quiet);
    }

    /**
     * 通知渠道重要性（静态版：插件与 Service 共用，不需要为此拉起服务）。
     * normal → IMPORTANCE_LOW（在下拉栏可见，无声）
     * quiet  → IMPORTANCE_NONE（不显示，服务照常；Android 不允许前台服务无通知，
     *          所以这是能做到的"最静"档）
     *
     * 级别只在两种情况下写入：①渠道首次创建时；②当前级别仍是 App 上次写入的值。
     * 用户自己在系统设置里改过渠道级别（与上次写入值不同）→ 尊重用户，不再覆盖。
     * 上次写入值记在本 App 私有 SharedPreferences，纯本机状态，不涉及其它组件。
     */
    static void applyNotificationMode(Context ctx, boolean quiet) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        android.content.SharedPreferences sp =
                ctx.getSharedPreferences(NOTIF_PREFS, Context.MODE_PRIVATE);
        int want = quiet ? NotificationManager.IMPORTANCE_NONE : NotificationManager.IMPORTANCE_LOW;
        NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
        if (ch == null) {
            // 首次创建：按当前模式定级别（重装/清数据后渠道重建，也在这一步生效）
            ch = new NotificationChannel(CHANNEL_ID, "后台播放", want);
            ch.setDescription("听书在后台播放时的常驻通知（关闭后不影响播放与锁屏控制）");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } else {
            // 渠道已存在：只在「级别还是 App 上次写入的值」时跟随模式更新。
            int last = "quiet".equals(sp.getString(PREF_LAST_MODE, null))
                    ? NotificationManager.IMPORTANCE_NONE
                    : NotificationManager.IMPORTANCE_LOW;
            if (ch.getImportance() == last && ch.getImportance() != want) {
                ch.setImportance(want);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        sp.edit().putString(PREF_LAST_MODE, quiet ? "quiet" : "normal").apply();
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
            // 记录「这条 LOW 是我们写的」，applyNotificationMode 的用户保护判断才准
            getSharedPreferences(NOTIF_PREFS, Context.MODE_PRIVATE)
                    .edit().putString(PREF_LAST_MODE, "normal").apply();
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
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Throwable ignored) {
        }
        super.onDestroy();
    }
}
