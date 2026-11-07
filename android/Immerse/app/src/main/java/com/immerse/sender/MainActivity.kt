package com.immerse.sender

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import java.nio.ByteBuffer
import java.nio.ByteOrder

class MainActivity : ComponentActivity() {
    private lateinit var receiverUrl: EditText
    private lateinit var connectButton: Button
    private lateinit var shareButton: Button
    private lateinit var stopButton: Button
    private lateinit var statusText: TextView

    private var socket: WebSocket? = null
    private var sessionId: String? = null
    private var peer: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null
    private var capturer: ScreenCapturerAndroid? = null
    private var videoSource: VideoSource? = null
    private var eglBase: EglBase? = null
    private var projectionResult: Intent? = null
    private var mediaProjection: MediaProjection? = null
    private var playbackAudio: AudioRecord? = null
    private var playbackThread: Thread? = null
    private var playbackChannel: org.webrtc.DataChannel? = null
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private val projectionRequest = 700
    private val audioRequest = 701

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        receiverUrl = findViewById(R.id.receiverUrl)
        connectButton = findViewById(R.id.connectButton)
        shareButton = findViewById(R.id.shareButton)
        stopButton = findViewById(R.id.stopButton)
        statusText = findViewById(R.id.statusText)

        connectButton.setOnClickListener { connect() }
        shareButton.setOnClickListener { requestCapture() }
        stopButton.setOnClickListener { stopSharing() }
    }

    private fun setStatus(message: String) {
        runOnUiThread { statusText.text = message }
    }

    private fun connect() {
        val rawUrl = receiverUrl.text.toString().trim()
        if (rawUrl.isBlank()) {
            setStatus("Enter the laptop WebSocket URL first")
            return
        }
        val url = rawUrl.replace("http://", "ws://").replace("https://", "wss://")
        socket?.close(1000, "reconnect")
        socket = OkHttpClient().newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                socket = webSocket
                webSocket.send("{\"type\":\"hello\",\"role\":\"sender\"}")
                setStatus("Connected. Tap Share, then approve it on the laptop.")
                shareButton.isEnabled = true
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleSignal(JSONObject(text))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                setStatus("Connection failed: ${t.message ?: "unknown error"}")
                shareButton.isEnabled = false
            }
        })
    }

    private fun requestCapture() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), audioRequest)
            setStatus("Allow audio capture, then tap Share again")
            return
        }
        val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), projectionRequest)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == projectionRequest && resultCode == Activity.RESULT_OK && data != null) {
            projectionResult = data
            startService(Intent(this, CaptureNotificationService::class.java))
            initializePeer(resultCode)
        } else if (requestCode == projectionRequest) {
            setStatus("Screen capture permission was cancelled")
        }
    }

    private fun initializePeer(resultCode: Int) {
        val result = projectionResult ?: return
        val currentSession = sessionId ?: run {
            setStatus("Waiting for the receiver session")
            return
        }
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.Q) {
            setStatus("Android 10 or newer is required for device audio capture")
            return
        }
        val projectionManager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = projectionManager.getMediaProjection(resultCode, result)
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions()
        )
        eglBase = EglBase.create()
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase!!.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase!!.eglBaseContext))
            .createPeerConnectionFactory()

        val configuration = PeerConnection.RTCConfiguration(emptyList())
        peer = factory!!.createPeerConnection(configuration, peerObserver(currentSession))
        videoSource = factory!!.createVideoSource(false)
        val helper = SurfaceTextureHelper.create("ImmerseScreenCapture", eglBase!!.eglBaseContext)
        capturer = ScreenCapturerAndroid(result, object : MediaProjection.Callback() {
            override fun onStop() { stopSharing() }
        })
        capturer!!.initialize(helper, this, videoSource!!.capturerObserver)
        capturer!!.startCapture(1280, 720, 30)

        val videoTrack = factory!!.createVideoTrack("immerse-screen", videoSource)
        peer!!.addTrack(videoTrack, listOf("immerse-stream"))
        val playbackInit = org.webrtc.DataChannel.Init().apply {
            ordered = false
            maxRetransmits = 0
        }
        playbackChannel = peer!!.createDataChannel("playback-audio", playbackInit)
        startPlaybackCapture()
        shareButton.isEnabled = false
        stopButton.isEnabled = true
        setStatus("Screen selected. Waiting for laptop approval...")
    }

    private fun startPlaybackCapture() {
        val projection = mediaProjection ?: return
        val captureConfig = android.media.AudioPlaybackCaptureConfiguration.Builder(projection)
            .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
            .addMatchingUsage(AudioAttributes.USAGE_GAME)
            .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
            .build()
        val audioFormat = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(48000)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val minimumBuffer = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        playbackAudio = AudioRecord.Builder()
            .setAudioFormat(audioFormat)
            .setAudioPlaybackCaptureConfig(captureConfig)
            .setBufferSizeInBytes(maxOf(minimumBuffer, 3840 * 4))
            .build()
        playbackAudio?.startRecording()
        playbackThread = Thread {
            val samples = ShortArray(1920)
            while (!Thread.currentThread().isInterrupted) {
                val count = playbackAudio?.read(samples, 0, samples.size) ?: 0
                val channel = playbackChannel
                if (count > 0 && channel?.state() == org.webrtc.DataChannel.State.OPEN) {
                    val bytes = ByteBuffer.allocate(count * 2).order(ByteOrder.LITTLE_ENDIAN)
                    for (index in 0 until count) bytes.putShort(samples[index])
                    bytes.flip()
                    channel.send(org.webrtc.DataChannel.Buffer(bytes, false))
                }
            }
        }.also { it.start() }
    }

    private fun peerObserver(currentSession: String) = object : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate) {
            sendSignal(JSONObject().put("type", "candidate").put("sessionId", currentSession).put("candidate", JSONObject().apply {
                put("sdpMid", candidate.sdpMid)
                put("sdpMLineIndex", candidate.sdpMLineIndex)
                put("candidate", candidate.sdp)
            }))
        }
        override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) {
            setStatus("WebRTC: ${newState.name.lowercase()}")
        }
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: org.webrtc.DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, mediaStreams: Array<out MediaStream>) = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
    }

    private fun createOffer() {
        peer?.createOffer(object : SdpObserver {
            override fun onCreateSuccess(description: SessionDescription) {
                peer?.setLocalDescription(this, description)
                sendSignal(JSONObject().put("type", "offer").put("sessionId", sessionId).put("offer", JSONObject().put("type", description.type.canonicalForm()).put("sdp", description.description)))
            }
            override fun onSetSuccess() = Unit
            override fun onCreateFailure(error: String) { setStatus("Offer failed: $error") }
            override fun onSetFailure(error: String) { setStatus("Offer setup failed: $error") }
        }, MediaConstraints())
    }

    private fun handleSignal(message: JSONObject) {
        when (message.optString("type")) {
            "registered" -> sessionId = message.optString("sessionId")
            "accepted" -> {
                setStatus("Accepted. Connecting to laptop...")
                createOffer()
            }
            "answer" -> {
                val answer = message.getJSONObject("answer")
                peer?.setRemoteDescription(object : SdpObserver {
                    override fun onSetSuccess() { pendingCandidates.forEach { peer?.addIceCandidate(it) }; pendingCandidates.clear() }
                    override fun onCreateSuccess(description: SessionDescription) = Unit
                    override fun onCreateFailure(error: String) = Unit
                    override fun onSetFailure(error: String) { setStatus("Answer failed: $error") }
                }, SessionDescription(SessionDescription.Type.ANSWER, answer.getString("sdp")))
            }
            "candidate" -> {
                val item = message.getJSONObject("candidate")
                val candidate = IceCandidate(item.optString("sdpMid"), item.getInt("sdpMLineIndex"), item.getString("candidate"))
                if (peer?.remoteDescription != null) peer?.addIceCandidate(candidate) else pendingCandidates.add(candidate)
            }
            "rejected", "session-ended" -> setStatus("Laptop ended this share")
        }
    }

    private fun sendSignal(message: JSONObject) {
        socket?.send(message.toString())
    }

    private fun stopSharing() {
        playbackThread?.interrupt()
        playbackThread = null
        playbackAudio?.stop()
        playbackAudio?.release()
        playbackAudio = null
        playbackChannel?.dispose()
        playbackChannel = null
        mediaProjection?.stop()
        mediaProjection = null
        capturer?.stopCapture()
        peer?.close()
        stopService(Intent(this, CaptureNotificationService::class.java))
        shareButton.isEnabled = socket != null
        stopButton.isEnabled = false
        setStatus("Sharing stopped")
    }

    override fun onDestroy() {
        stopSharing()
        socket?.close(1000, "activity closed")
        super.onDestroy()
    }
}
