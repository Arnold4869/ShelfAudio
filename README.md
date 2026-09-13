# ShelfAudio（听书）

儿童友好的 Audiobookshelf 有声书播放器，iOS + Android 一套代码。

## 功能

**儿童模式**（默认）
- 大卡片书架、大圆按钮播放页
- 语音搜索 / 语音指令（暂停、下一集、大声点…）
- 家长密码保护（切成人模式、进设置都要输）

**成人模式**
- 章节列表、倍速（0.75/1/1.25/1.5/2）、睡眠定时
- 收藏夹、书籍信息、继续听

**通用**
- 后台播放 + 锁屏/通知栏控制（书名、封面、进度、上一集/下一集）
- 进度与 ABS 官方 App / 网页版互通（走 playback session 同步）
- 服务器地址与账号在 App 内配置，不写死

## 架构

- 前端：原生 JS + CSS（无框架），Vite 打包
- 跨平台：Capacitor 8
- 播放：`@capgo/capacitor-native-audio`（原生播放器，非 HTML5 audio）
- 语音：`@capgo/capacitor-speech-recognition`（用系统识别，免费、无需自建服务）
- Android 后台播放：自建前台服务 `PlaybackService.java`（插件不含此能力，官方文档要求 App 自己管）

```
src/
├── index.html          # 外壳：闪屏、迷你播放条、家长锁
├── app.js              # 路由 + 全局状态 + 模式切换
├── styles.css
├── lib/
│   ├── api.js          # ABS API 客户端
│   ├── player.js       # 播放引擎（原生/浏览器双实现）
│   ├── store.js        # 配置持久化（原生 Preferences）
│   ├── voice.js        # 语音识别 + 指令解析
│   └── voice-ui.js     # 语音浮层
└── views/              # login / shelf / player / search / settings
android/app/src/main/java/com/arnold/shelfaudio/
├── MainActivity.java          # 注册插件
├── PlaybackService.java       # 前台服务（后台播放必需）
└── PlaybackServicePlugin.java # JS 桥
ios/App/App/Info.plist         # UIBackgroundModes=audio + 麦克风/语音权限
```

## 构建

全部在 GitHub Actions 完成（NAS 无 Mac / 无本地 Android SDK）：

- `.github/workflows/build-android.yml` → `ShelfAudio-<版本>.apk`
- `.github/workflows/build-ios.yml` → `ShelfAudio-unsigned.ipa`（未签名，Sideloadly 侧载）

推送到 `main` 即触发；也可在 Actions 页手动 `Run workflow`。

版本号写在仓库根 `VERSION` 文件（`MAJOR.MINOR.PATCH`）。

## 首次使用

1. 装好 App，填服务器地址（局域网填 `http://内网IP:端口`，外网填反代地址）、用户名、密码
2. 进设置设一个**家长密码**
3. 娃用儿童模式；你自己切成人模式需输家长密码

## 已知限制

- iOS 需侧载（免费签名 7 天有效），重装会清本地配置，需重登
- 倍速在 iOS 有效；Android 是否生效待真机验证（插件 RemoteAudioAsset 未覆写 setRate）
- 离线下载尚未实现（规划中）
