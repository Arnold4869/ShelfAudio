// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.2"),
        .package(name: "CapgoCapacitorNativeAudio", path: "../../../node_modules/@capgo/capacitor-native-audio"),
        .package(name: "CapgoCapacitorSpeechRecognition", path: "../../../node_modules/@capgo/capacitor-speech-recognition"),
        .package(name: "CapacitorPreferences", path: "../../../node_modules/@capacitor/preferences")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "CapgoCapacitorNativeAudio", package: "CapgoCapacitorNativeAudio"),
                .product(name: "CapgoCapacitorSpeechRecognition", package: "CapgoCapacitorSpeechRecognition"),
                .product(name: "CapacitorPreferences", package: "CapacitorPreferences")
            ]
        )
    ]
)
