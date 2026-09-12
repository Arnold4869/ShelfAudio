package com.arnold.shelfaudio;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册自定义插件必须在 super.onCreate 之前
        registerPlugin(PlaybackServicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
