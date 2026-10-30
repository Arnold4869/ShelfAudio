package com.arnold.shelfaudio;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

/**
 * 前台服务控制插件（JS 可调用）
 *
 * 背景：@capgo/capacitor-native-audio 只负责音频与 MediaSession 通知，
 * Android 后台播放所需的前台服务必须由 App 自己管理（插件文档明确说明）。
 *
 * JS 用法：
 *   import { registerPlugin } from '@capacitor/core'
 *   const Fg = registerPlugin('ForegroundService')
 *   await Fg.start({ title: '书名', text: '第 3 集' })   // 播放前
 *   await Fg.stop()                                      // 停止播放
 */
@CapacitorPlugin(name = "ForegroundService")
public class PlaybackServicePlugin extends Plugin {

    private Intent buildIntent(String action, PluginCall call) {
        Intent i = new Intent(getContext(), PlaybackService.class);
        i.setAction(action);
        if (call != null) {
            String title = call.getString("title");
            String text = call.getString("text");
            i.putExtra(PlaybackService.EXTRA_TITLE, title != null ? title : "听书");
            i.putExtra(PlaybackService.EXTRA_TEXT, text != null ? text : "正在播放");
        }
        return i;
    }

    @PluginMethod
    public void start(PluginCall call) {
        // 任何异常都必须 catch —— 抛到 UI 线程会整个 App 崩溃
        try {
            Intent i = buildIntent(PlaybackService.ACTION_START, call);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
            call.resolve();
        } catch (Throwable t) {
            call.reject("启动前台服务失败: " + t.getMessage());
        }
    }

    @PluginMethod
    public void update(PluginCall call) {
        try {
            // Android 8+ 后台时 startService() 抛 IllegalStateException（更新通知
            // 常发生在锁屏/切后台后）。改 startForegroundService：服务已在跑时
            // 等价于投递 onStartCommand；没在跑时 ACTION_UPDATE 分支会走 startForeground，合法。
            ContextCompat.startForegroundService(getContext(),
                    buildIntent(PlaybackService.ACTION_UPDATE, call));
            call.resolve();
        } catch (Throwable t) {
            call.reject("更新通知失败: " + t.getMessage());
        }
    }

    /** 老板 2026-09-13：普通通知静默开关（锁屏控制保留，见 PlaybackService.applyNotificationMode） */
    @PluginMethod
    public void setNotificationMode(PluginCall call) {
        try {
            String mode = call.getString("mode", "normal");
            // 渠道级别是 NotificationManager 的纯本机操作，不需要经过服务 ——
            // 直接静态调用即可（也避免了后台 startService 抛错 / 为改渠道凭空拉起服务）。
            PlaybackService.applyNotificationMode(getContext(), "quiet".equals(mode));
            call.resolve();
        } catch (Throwable t) {
            call.reject("设置通知模式失败: " + t.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            // 停服务用 stopService()：①后台调用不受限（startService 在 O+ 后台必抛）；②不经过
            // startForegroundService（那样要求服务随后必须 startForeground，ACTION_STOP
            // 分支只 stopSelf，服务本来没在跑时会触发 DidNotStartInTime 崩溃）。
            // 通知移除由 PlaybackService.onDestroy() 的 stopForeground(STOP_FOREGROUND_REMOVE) 兜底。
            getContext().stopService(new Intent(getContext(), PlaybackService.class));
            call.resolve();
        } catch (Throwable t) {
            call.reject("停止前台服务失败: " + t.getMessage());
        }
    }
}
