package com.arnold.shelfaudio;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Intent;
import android.os.Build;

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
            getContext().startService(buildIntent(PlaybackService.ACTION_UPDATE, call));
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
            Intent i = new Intent(getContext(), PlaybackService.class);
            i.setAction(PlaybackService.ACTION_NOTIFICATION_MODE);
            i.putExtra(PlaybackService.EXTRA_NOTIF_MODE, mode);
            getContext().startService(i);
            call.resolve();
        } catch (Throwable t) {
            call.reject("设置通知模式失败: " + t.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        try {
            getContext().startService(buildIntent(PlaybackService.ACTION_STOP, call));
            call.resolve();
        } catch (Throwable t) {
            call.reject("停止前台服务失败: " + t.getMessage());
        }
    }
}
