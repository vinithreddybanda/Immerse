# Immerse Android sender

This app captures the Android display with `MediaProjection` and sends it to the Immerse laptop receiver over a direct WebRTC connection. The laptop dashboard still approves the session before the offer is sent.

## Build

1. Install Android Studio or the Android SDK with platform 35 and build tools.
2. Set `ANDROID_HOME` or create `android/Immerse/local.properties` with `sdk.dir=/absolute/path/to/Android/sdk`.
3. From this directory, run `gradle assembleDebug`.
4. Install `app/build/outputs/apk/debug/app-debug.apk` on an Android 8.0+ phone.

## Use

1. Start the Node receiver from the repository root with `npm start`.
2. Find the laptop's Wi-Fi address and enter `ws://LAPTOP_IP:3100/signal` in the app.
3. Tap **Connect to laptop**, then **Share whole screen + audio**.
4. Approve the pending sender on `http://LAPTOP_IP:3100`.

The phone and laptop must be on the same network. A phone hotspot works: enable the hotspot, connect the laptop to it, then use the laptop's hotspot-assigned IP in the app. The app uses direct ICE with no media relay, so the video and audio do not pass through the Node server.

On Android 10+, the app captures allowed media and game playback with `AudioPlaybackCaptureConfiguration`, sends 20 ms PCM packets over a WebRTC data channel, and the laptop plays them with an `AudioWorklet`. Protected apps, phone calls, DRM media, and apps that opt out of playback capture will not provide audio. This is intentionally direct and relay-free for low latency.
