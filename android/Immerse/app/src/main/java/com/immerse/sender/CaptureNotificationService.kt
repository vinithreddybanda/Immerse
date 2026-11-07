package com.immerse.sender

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.IBinder

class CaptureNotificationService : Service() {
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel("immerse_capture", "Immerse screen sharing", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, "immerse_capture")
            .setContentTitle("Immerse is sharing your screen")
            .setContentText("The laptop is receiving your screen")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .build()
        startForeground(1001, notification)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onBind(intent: Intent?): IBinder? = null
}
