package com.myesther.app

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.core.content.ContextCompat
import androidx.compose.animation.*
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.myesther.app.core.CryptoManager
import com.myesther.app.core.QRCodeHelper
import com.myesther.app.core.RelayManager
import com.myesther.app.core.TicketManager
import compose.icons.TablerIcons
import compose.icons.tablericons.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream

// Message Model in RAM
data class GhostMessage(
    val id: String = java.util.UUID.randomUUID().toString(),
    val type: String = "text", // "text" | "voice"
    val content: String,       // Text or temp audio path / data
    val isMe: Boolean,
    val durationSeconds: Int = 0,
    val timestamp: Long = System.currentTimeMillis(),
    val createdAt: Long = System.currentTimeMillis()
)

class MainActivity : ComponentActivity() {

    private val sharedSecretFromIntent = mutableStateOf("")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Ghost App: Bloquer les captures d'écran et enregistrements
        window.setFlags(
            android.view.WindowManager.LayoutParams.FLAG_SECURE,
            android.view.WindowManager.LayoutParams.FLAG_SECURE
        )

        handleDeepLink(intent)
        
        setContent {
            MaterialTheme(
                typography = Typography(
                    bodyLarge = TextStyle(fontFamily = androidx.compose.ui.text.font.FontFamily.SansSerif)
                )
            ) {
                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = Color.White
                ) {
                    MyEstherApp(initialSecret = sharedSecretFromIntent.value)
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLink(intent)
    }

    private fun handleDeepLink(intent: Intent?) {
        val data: Uri? = intent?.data
        if (data != null) {
            var ticket: String? = data.getQueryParameter("ticket") ?: data.getQueryParameter("token")
            
            // Check fragment for hash tickets like https://myesther-m7y9.onrender.com/#ticket=...
            if (ticket.isNullOrEmpty()) {
                val fragment = data.fragment
                if (!fragment.isNullOrEmpty() && fragment.contains("ticket=")) {
                    ticket = fragment.substringAfter("ticket=").substringBefore("&")
                }
            }

            if (!ticket.isNullOrEmpty()) {
                val decodedSecret = TicketManager.parseEphemeralTicket(ticket)
                if (decodedSecret != null) {
                    sharedSecretFromIntent.value = decodedSecret
                    Toast.makeText(this, "Invitation déverrouillée avec succès !", Toast.LENGTH_SHORT).show()
                } else {
                    Toast.makeText(this, "Le lien d'invitation a expiré ou est invalide.", Toast.LENGTH_LONG).show()
                }
            } else {
                val secret = data.getQueryParameter("secret")
                if (!secret.isNullOrEmpty()) {
                    sharedSecretFromIntent.value = secret
                }
            }
        }
    }
}

// Colors from Web CSS
val JoyBgGradient = Brush.linearGradient(listOf(Color(0xFFF5F3FF), Color(0xFFFCE7F3), Color(0xFFEFF6FF)))
val BrandGradient = Brush.linearGradient(listOf(Color(0xFF7C3AED), Color(0xFFA855F7)))
val TextDark = Color(0xFF1A1A2E)
val TextGray = Color(0xFF9CA3AF)
val InputBg = Color(0xFFF9F5FF)
val InputBorder = Color(0xFFEDE9FE)
val CardBorder = Color(0xFFF5F3FF)
val BubbleRecv = Color(0xFFF3F4F6)

@Composable
fun MyEstherApp(initialSecret: String = "") {
    var inRoom by remember { mutableStateOf(false) }
    var inPanicCalculator by remember { mutableStateOf(false) }
    
    // States
    var alias by remember { mutableStateOf("") }
    var password by remember { mutableStateOf(initialSecret) }
    var enableLobby by remember { mutableStateOf(false) }
    var cryptoManager by remember { mutableStateOf<CryptoManager?>(null) }
    
    val context = LocalContext.current
    val connectionStatus by RelayManager.connectionStatus.collectAsState()
    val incomingPayload by RelayManager.incomingPayloads.collectAsState()
    val knockRequest by RelayManager.knockRequest.collectAsState()
    val guestKnockStatus by RelayManager.guestKnockStatus.collectAsState()

    // RAM-only message storage (Auto-destroyed when process ends)
    val chatMessages = remember { mutableStateListOf<GhostMessage>() }

    // Audio recording & playback helpers
    var isRecording by remember { mutableStateOf(false) }
    var recordingDuration by remember { mutableStateOf(0) }
    var mediaRecorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var currentAudioFile by remember { mutableStateOf<File?>(null) }

    val coroutineScope = rememberCoroutineScope()

    // Permission launcher for Recording & Notifications
    val multiplePermissionsLauncher = rememberLauncherForActivityResult(
        contract = androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        // Continue connection
        val secretToUse = password.ifEmpty { "DefaultSecret" }
        cryptoManager = CryptoManager(secretToUse)
        val serverUrl = "https://myesther-m7y9.onrender.com"
        
        RelayManager.connect(
            serverUrl = serverUrl,
            secret = secretToUse,
            alias = alias.ifEmpty { "MobileUser" },
            lobbyEnabled = enableLobby
        )
        
        chatMessages.clear()
        chatMessages.add(GhostMessage(content = "Bienvenue ! Vos messages disparaissent dès la fermeture de l'application.", isMe = false))
        inRoom = true
    }

    // Auto-destruct timer for Ghost Voice messages (5 minutes max)
    LaunchedEffect(Unit) {
        while (true) {
            delay(5000) // Check every 5s
            val now = System.currentTimeMillis()
            val expired = chatMessages.filter { it.type == "voice" && (now - it.createdAt) >= 300_000 }
            if (expired.isNotEmpty()) {
                expired.forEach { msg ->
                    if (msg.type == "voice") {
                        try { File(msg.content).delete() } catch (e: Exception) {}
                    }
                    chatMessages.remove(msg)
                }
            }
        }
    }

    // Decrypt incoming payloads
    LaunchedEffect(incomingPayload) {
        val payload = incomingPayload
        if (payload != null && cryptoManager != null) {
            val type = payload.optString("type", "msg")
            if (type == "nuke") {
                // Emergency remote nuke from host
                chatMessages.clear()
                RelayManager.disconnect()
                inRoom = false
                Toast.makeText(context, "Session détruite par l'hôte.", Toast.LENGTH_SHORT).show()
                return@LaunchedEffect
            }
            val raw = payload.optString("content")
            
            if (!raw.isNullOrEmpty()) {
                val decrypted = cryptoManager!!.decryptPayload(raw)
                if (decrypted != "ERROR_DECRYPT_OR_WRONG_KEY") {
                    if (type == "voice") {
                        try {
                            val audioBase64 = decrypted.substringAfter("base64,")
                            val audioBytes = Base64.decode(audioBase64, Base64.NO_WRAP)
                            val tempFile = File(context.cacheDir, "ghost_voice_${System.currentTimeMillis()}.m4a")
                            FileOutputStream(tempFile).use { it.write(audioBytes) }
                            
                            val dur = payload.optInt("duration", 0)
                            chatMessages.add(GhostMessage(type = "voice", content = tempFile.absolutePath, isMe = false, durationSeconds = dur))
                        } catch (e: Exception) {
                            e.printStackTrace()
                        }
                    } else {
                        chatMessages.add(GhostMessage(type = "text", content = decrypted, isMe = false))
                    }
                }
            }
        }
    }

    // Host Knock Modal Dialog (Lobby Approval)
    if (knockRequest != null) {
        val (guestSid, guestAlias) = knockRequest!!
        AlertDialog(
            onDismissRequest = {},
            title = { Text("Demande pour rejoindre", fontWeight = FontWeight.Bold) },
            text = { Text("'$guestAlias' souhaite entrer dans votre discussion. Accepter ?") },
            confirmButton = {
                Button(
                    onClick = {
                        RelayManager.approveKnock(guestSid)
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF7C3AED))
                ) {
                    Text("Accepter", fontWeight = FontWeight.Bold)
                }
            },
            dismissButton = {
                TextButton(
                    onClick = {
                        RelayManager.rejectKnock(guestSid)
                    }
                ) {
                    Text("Refuser", color = Color.Red, fontWeight = FontWeight.Bold)
                }
            },
            shape = RoundedCornerShape(24.dp),
            containerColor = Color.White
        )
    }

    if (inPanicCalculator) {
        PanicCalculatorScreen(onUnlock = { inPanicCalculator = false })
    } else {
        Crossfade(targetState = inRoom, label = "ScreenTransition") { inChat ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(JoyBgGradient)
            ) {
                if (!inChat) {
                    SetupScreen(
                        alias = alias,
                        onAliasChange = { alias = it },
                        password = password,
                        onPasswordChange = { password = it },
                        enableLobby = enableLobby,
                        onEnableLobbyChange = { enableLobby = it },
                        guestKnockStatus = guestKnockStatus,
                        onConnect = {
                            val permissionsNeeded = mutableListOf<String>()
                            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                                    permissionsNeeded.add(Manifest.permission.POST_NOTIFICATIONS)
                                }
                            }
                            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                                permissionsNeeded.add(Manifest.permission.RECORD_AUDIO)
                            }

                            if (permissionsNeeded.isNotEmpty()) {
                                multiplePermissionsLauncher.launch(permissionsNeeded.toTypedArray())
                            } else {
                                val secretToUse = password.ifEmpty { "DefaultSecret" }
                                cryptoManager = CryptoManager(secretToUse)
                                val serverUrl = "https://myesther-m7y9.onrender.com"
                                
                                RelayManager.connect(
                                    serverUrl = serverUrl,
                                    secret = secretToUse,
                                    alias = alias.ifEmpty { "MobileUser" },
                                    lobbyEnabled = enableLobby
                                )
                                chatMessages.clear()
                                chatMessages.add(GhostMessage(content = "Bienvenue ! Vos messages disparaissent dès la fermeture de l'application.", isMe = false))
                                inRoom = true
                            }
                        }
                    )
                } else {
                    ChatScreen(
                        connectionStatus = connectionStatus,
                        messages = chatMessages,
                        sessionSecret = password.ifEmpty { "DefaultSecret" },
                        isRecording = isRecording,
                        recordingDuration = recordingDuration,
                        onTriggerPanic = { inPanicCalculator = true },
                        onNukeSession = {
                            val payload = JSONObject().apply {
                                put("type", "nuke")
                                put("sender", alias.ifEmpty { "MobileUser" })
                            }
                            RelayManager.sendPayload(payload)
                            RelayManager.disconnect()
                            chatMessages.clear()
                            inRoom = false
                            Toast.makeText(context, "Discussion détruite sans trace.", Toast.LENGTH_SHORT).show()
                        },
                        onStartRecording = {
                            try {
                                val audioFile = File(context.cacheDir, "record_${System.currentTimeMillis()}.m4a")
                                currentAudioFile = audioFile
                                val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                                    MediaRecorder(context)
                                } else {
                                    MediaRecorder()
                                }
                                recorder.apply {
                                    setAudioSource(MediaRecorder.AudioSource.MIC)
                                    setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                                    setOutputFile(audioFile.absolutePath)
                                    prepare()
                                    start()
                                }
                                mediaRecorder = recorder
                                isRecording = true
                                recordingDuration = 0
                                
                                coroutineScope.launch {
                                    while (isRecording) {
                                        delay(1000)
                                        recordingDuration++
                                        if (recordingDuration >= 60) {
                                            isRecording = false
                                            try {
                                                recorder.stop()
                                                recorder.release()
                                            } catch (e: Exception) {}
                                            mediaRecorder = null
                                            
                                            val bytes = FileInputStream(audioFile).readBytes()
                                            val base64Data = "data:audio/mp4;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                                            val encrypted = cryptoManager?.encryptPayload(base64Data) ?: ""
                                            
                                            val payload = JSONObject().apply {
                                                put("type", "voice")
                                                put("content", encrypted)
                                                put("duration", recordingDuration)
                                                put("sender", alias.ifEmpty { "MobileUser" })
                                            }
                                            
                                            RelayManager.sendPayload(payload)
                                            chatMessages.add(GhostMessage(type = "voice", content = audioFile.absolutePath, isMe = true, durationSeconds = recordingDuration))
                                        }
                                    }
                                }
                            } catch (e: Exception) {
                                Toast.makeText(context, "Erreur micro: ${e.message}", Toast.LENGTH_SHORT).show()
                            }
                        },
                        onStopRecording = { cancel ->
                            isRecording = false
                            try {
                                mediaRecorder?.stop()
                                mediaRecorder?.release()
                                mediaRecorder = null
                            } catch (e: Exception) {}

                            if (!cancel && currentAudioFile != null && currentAudioFile!!.exists()) {
                                val bytes = FileInputStream(currentAudioFile!!).readBytes()
                                val base64Data = "data:audio/mp4;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)
                                val encrypted = cryptoManager?.encryptPayload(base64Data) ?: ""
                                
                                val payload = JSONObject().apply {
                                    put("type", "voice")
                                    put("content", encrypted)
                                    put("duration", recordingDuration)
                                    put("sender", alias.ifEmpty { "MobileUser" })
                                }
                                
                                RelayManager.sendPayload(payload)
                                chatMessages.add(GhostMessage(type = "voice", content = currentAudioFile!!.absolutePath, isMe = true, durationSeconds = recordingDuration))
                            } else if (cancel) {
                                currentAudioFile?.delete()
                            }
                        },
                        onSendMessage = { msgText ->
                            if (msgText.isNotBlank() && cryptoManager != null) {
                                chatMessages.add(GhostMessage(type = "text", content = msgText, isMe = true))
                                
                                val encrypted = cryptoManager!!.encryptPayload(msgText)
                                val payload = JSONObject().apply {
                                    put("type", "msg")
                                    put("content", encrypted)
                                    put("sender", alias.ifEmpty { "MobileUser" })
                                }
                                
                                RelayManager.sendPayload(payload)
                            }
                        },
                        onLeave = {
                            RelayManager.disconnect()
                            chatMessages.clear()
                            inRoom = false
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun SetupScreen(
    alias: String, onAliasChange: (String) -> Unit,
    password: String, onPasswordChange: (String) -> Unit,
    enableLobby: Boolean, onEnableLobbyChange: (Boolean) -> Unit,
    guestKnockStatus: String?,
    onConnect: () -> Unit
) {
    var passwordVisible by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Logo & Title
        Box(
            modifier = Modifier
                .size(90.dp)
                .shadow(16.dp, RoundedCornerShape(26.dp), spotColor = Color(0xFF7C3AED))
                .clip(RoundedCornerShape(26.dp))
                .background(Color.White)
                .border(1.dp, CardBorder, RoundedCornerShape(26.dp)),
            contentAlignment = Alignment.Center
        ) {
            Image(
                painter = painterResource(id = R.drawable.myesther_logo),
                contentDescription = "MyEsther Logo",
                modifier = Modifier.fillMaxSize()
            )
        }
        
        Spacer(modifier = Modifier.height(14.dp))
        Text("MyEsther", fontSize = 36.sp, fontWeight = FontWeight.Black, color = TextDark)
        Text("MESSAGERIE PRIVÉE ET ÉPHÉMÈRE", fontSize = 11.sp, fontWeight = FontWeight.Bold, color = TextGray, letterSpacing = 1.sp)
        
        Spacer(modifier = Modifier.height(28.dp))
        
        // Form Card
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = Color.White),
            shape = RoundedCornerShape(28.dp),
            elevation = CardDefaults.cardElevation(defaultElevation = 10.dp)
        ) {
            Column(modifier = Modifier.padding(24.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                    // Alias
                    Column(modifier = Modifier.weight(0.35f)) {
                        Text("VOTRE PSEUDO", fontSize = 10.sp, fontWeight = FontWeight.Black, color = TextGray, letterSpacing = 0.5.sp)
                        Spacer(modifier = Modifier.height(8.dp))
                        BasicTextField(
                            value = alias,
                            onValueChange = onAliasChange,
                            textStyle = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, color = TextDark),
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(InputBg, RoundedCornerShape(16.dp))
                                .border(2.dp, InputBorder, RoundedCornerShape(16.dp))
                                .padding(14.dp),
                            decorationBox = { innerTextField ->
                                if (alias.isEmpty()) Text("Pseudo", color = Color(0xFFD1D5DB), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                innerTextField()
                            }
                        )
                    }
                    
                    // Secret
                    Column(modifier = Modifier.weight(0.65f)) {
                        Text("MOT DE PASSE DU SALON", fontSize = 10.sp, fontWeight = FontWeight.Black, color = TextGray, letterSpacing = 0.5.sp)
                        Spacer(modifier = Modifier.height(8.dp))
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .background(InputBg, RoundedCornerShape(16.dp))
                                .border(2.dp, InputBorder, RoundedCornerShape(16.dp))
                                .padding(14.dp),
                            contentAlignment = Alignment.CenterStart
                        ) {
                            BasicTextField(
                                value = password,
                                onValueChange = onPasswordChange,
                                textStyle = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.Bold, color = TextDark),
                                visualTransformation = if (passwordVisible) VisualTransformation.None else PasswordVisualTransformation(),
                                modifier = Modifier.fillMaxWidth().padding(end = 24.dp),
                                decorationBox = { innerTextField ->
                                    if (password.isEmpty()) Text("Code secret...", color = Color(0xFFD1D5DB), fontWeight = FontWeight.Bold, fontSize = 14.sp)
                                    innerTextField()
                                }
                            )
                            Icon(
                                if (passwordVisible) TablerIcons.EyeOff else TablerIcons.Eye,
                                contentDescription = null,
                                tint = TextGray,
                                modifier = Modifier.align(Alignment.CenterEnd).size(20.dp).clickable { passwordVisible = !passwordVisible }
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(16.dp))

                // Lobby Option Toggle
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Color(0xFFF5F3FF), RoundedCornerShape(16.dp))
                        .clickable { onEnableLobbyChange(!enableLobby) }
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(TablerIcons.ShieldLock, contentDescription = null, tint = Color(0xFF7C3AED), modifier = Modifier.size(18.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Filtrer les entrées (Salle d'attente)", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = TextDark)
                    }
                    Switch(
                        checked = enableLobby,
                        onCheckedChange = onEnableLobbyChange,
                        colors = SwitchDefaults.colors(checkedThumbColor = Color.White, checkedTrackColor = Color(0xFF7C3AED))
                    )
                }

                if (guestKnockStatus == "WAITING") {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(
                        "En attente de l'autorisation de l'hôte...",
                        color = Color(0xFFD97706),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Bold,
                        modifier = Modifier.align(Alignment.CenterHorizontally)
                    )
                }
                
                Spacer(modifier = Modifier.height(20.dp))
                
                // Establish Button
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp)
                        .shadow(16.dp, RoundedCornerShape(18.dp), spotColor = Color(0xFF7C3AED))
                        .background(BrandGradient, RoundedCornerShape(18.dp))
                        .clickable { onConnect() },
                    contentAlignment = Alignment.Center
                ) {
                    Text("Démarrer la discussion", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Black)
                }
            }
        }
        
        Spacer(modifier = Modifier.height(24.dp))
        
        // Badges
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("100% PRIVÉ", fontSize = 11.sp, fontWeight = FontWeight.Black, color = TextGray, letterSpacing = 1.sp)
            Text("ÉPHÉMÈRE", fontSize = 11.sp, fontWeight = FontWeight.Black, color = TextGray, letterSpacing = 1.sp)
            Text("SANS TRACE", fontSize = 11.sp, fontWeight = FontWeight.Black, color = TextGray, letterSpacing = 1.sp)
        }
    }
}

@Composable
fun ChatScreen(
    connectionStatus: String,
    messages: List<GhostMessage>,
    sessionSecret: String,
    isRecording: Boolean,
    recordingDuration: Int,
    onTriggerPanic: () -> Unit,
    onNukeSession: () -> Unit,
    onStartRecording: () -> Unit,
    onStopRecording: (Boolean) -> Unit,
    onSendMessage: (String) -> Unit,
    onLeave: () -> Unit
) {
    var inputText by remember { mutableStateOf("") }
    var showShareModal by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current

    // Share & QR Modal
    if (showShareModal) {
        var refreshNonce by remember { mutableStateOf(0) }
        val ephemeralTicket = remember(sessionSecret, refreshNonce) {
            TicketManager.createEphemeralTicket(sessionSecret, ttlMinutes = 15)
        }
        val webShareLink = "https://myesther-m7y9.onrender.com/#ticket=$ephemeralTicket"
        val deepLink = "myesther://join?ticket=$ephemeralTicket"
        val qrBitmap = remember(ephemeralTicket) {
            try {
                QRCodeHelper.generateQRCodeBitmap(deepLink, 450)
            } catch (e: Exception) {
                null
            }
        }

        AlertDialog(
            onDismissRequest = { showShareModal = false },
            title = { Text("Inviter un ami", fontWeight = FontWeight.Bold) },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    Text("Partagez ce QR code ou ce lien pour discuter.", fontSize = 12.sp, color = TextGray)
                    Spacer(modifier = Modifier.height(14.dp))
                    
                    // High Density Cryptographic QR Code
                    Box(
                        modifier = Modifier
                            .size(190.dp)
                            .shadow(8.dp, RoundedCornerShape(20.dp), spotColor = Color(0xFF7C3AED))
                            .background(Color.White, RoundedCornerShape(20.dp))
                            .border(2.dp, Color(0xFFEDE9FE), RoundedCornerShape(20.dp))
                            .padding(14.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        if (qrBitmap != null) {
                            Image(
                                bitmap = qrBitmap.asImageBitmap(),
                                contentDescription = "QR Code d'invitation",
                                modifier = Modifier.fillMaxSize()
                            )
                        } else {
                            CircularProgressIndicator(color = Color(0xFF7C3AED))
                        }
                    }
                    
                    Spacer(modifier = Modifier.height(10.dp))
                    Text(
                        "VALABLE 15 MINUTES • USAGE UNIQUE",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = Color(0xFF7C3AED),
                        letterSpacing = 0.5.sp
                    )
                    
                    Spacer(modifier = Modifier.height(16.dp))
                    Button(
                        onClick = {
                            clipboardManager.setText(AnnotatedString(webShareLink))
                            Toast.makeText(context, "Lien d'invitation copié !", Toast.LENGTH_SHORT).show()
                        },
                        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFF5F3FF), contentColor = Color(0xFF7C3AED)),
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Icon(TablerIcons.Copy, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Copier le Lien d'Invitation", fontWeight = FontWeight.Bold, fontSize = 13.sp)
                    }

                    Spacer(modifier = Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = {
                            refreshNonce++
                            Toast.makeText(context, "Nouveau lien généré !", Toast.LENGTH_SHORT).show()
                        },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(14.dp)
                    ) {
                        Icon(TablerIcons.Refresh, contentDescription = null, modifier = Modifier.size(15.dp))
                        Spacer(modifier = Modifier.width(6.dp))
                        Text("Générer un Nouveau Lien", fontSize = 12.sp, fontWeight = FontWeight.Bold)
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showShareModal = false }) {
                    Text("Fermer", fontWeight = FontWeight.Bold)
                }
            },
            shape = RoundedCornerShape(24.dp),
            containerColor = Color.White
        )
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // Glass Header
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.White.copy(alpha = 0.9f))
                .border(1.dp, Color(0xFF7C3AED).copy(alpha = 0.1f))
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                TablerIcons.ArrowLeft, 
                contentDescription = "Back", 
                tint = TextGray, 
                modifier = Modifier.size(24.dp).clickable { onLeave() }
            )
            Spacer(modifier = Modifier.width(10.dp))
            
            Box(
                modifier = Modifier
                    .size(42.dp)
                    .clip(RoundedCornerShape(14.dp))
                    .background(Color(0xFFF5F3FF))
                    .border(1.dp, Color(0xFF7C3AED).copy(alpha = 0.2f), RoundedCornerShape(14.dp))
                    .clickable { onTriggerPanic() },
                contentAlignment = Alignment.Center
            ) {
                Image(
                    painter = painterResource(id = R.drawable.myesther_logo),
                    contentDescription = "Avatar",
                    modifier = Modifier.fillMaxSize()
                )
            }
            
            Spacer(modifier = Modifier.width(10.dp))
            Column(modifier = Modifier.weight(1f)) {
                Text("Discussion Privée", fontSize = 14.sp, fontWeight = FontWeight.Bold, color = TextDark)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(6.dp).background(Color(0xFF22C55E), CircleShape))
                    Spacer(modifier = Modifier.width(4.dp))
                    Text(if (connectionStatus.contains("Connect") || connectionStatus.contains("Secure")) "EN LIGNE" else "CONNEXION...", fontSize = 10.sp, fontWeight = FontWeight.Bold, color = TextGray)
                }
            }

            // Camouflage / Mode Calculatrice Button
            IconButton(onClick = { onTriggerPanic() }) {
                Icon(TablerIcons.Calculator, contentDescription = "Camouflage", tint = Color(0xFF6B7280), modifier = Modifier.size(20.dp))
            }

            // QR & Share Button
            IconButton(onClick = { showShareModal = true }) {
                Icon(TablerIcons.Qrcode, contentDescription = "Share", tint = Color(0xFF7C3AED), modifier = Modifier.size(20.dp))
            }

            // Nuke / Destruction immédiate
            IconButton(onClick = { onNukeSession() }) {
                Icon(TablerIcons.Flame, contentDescription = "Détruire", tint = Color(0xFFEF4444), modifier = Modifier.size(20.dp))
            }
        }
        
        // Chat Messages Canvas
        LazyColumn(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            reverseLayout = false
        ) {
            item { Spacer(modifier = Modifier.height(16.dp)) }
            
            item {
                Box(modifier = Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Text(
                        "DISCUSSION PRIVÉE • AUCUN MESSAGE CONSERVÉ",
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        color = TextGray,
                        modifier = Modifier.background(Color(0xFFF3F4F6), RoundedCornerShape(16.dp)).padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
                Spacer(modifier = Modifier.height(16.dp))
            }
            
            items(messages, key = { it.id }) { msg ->
                val isMe = msg.isMe
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    horizontalArrangement = if (isMe) Arrangement.End else Arrangement.Start
                ) {
                    if (msg.type == "voice") {
                        // Voice Message Bubble
                        GhostVoiceBubble(msg = msg, isMe = isMe)
                    } else {
                        // Text Bubble
                        Box(
                            modifier = Modifier
                                .fillMaxWidth(0.82f)
                                .background(
                                    if (isMe) BrandGradient else Brush.linearGradient(listOf(BubbleRecv, BubbleRecv)),
                                    shape = if (isMe) RoundedCornerShape(22.dp, 22.dp, 4.dp, 22.dp) else RoundedCornerShape(22.dp, 22.dp, 22.dp, 4.dp)
                                )
                                .padding(horizontal = 20.dp, vertical = 12.dp)
                        ) {
                            Text(
                                text = msg.content,
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Bold,
                                color = if (isMe) Color.White else TextDark,
                                lineHeight = 20.sp
                            )
                        }
                    }
                }
            }
            
            item { Spacer(modifier = Modifier.height(16.dp)) }
        }

        // Live Voice Recording Bar
        if (isRecording) {
            val m = recordingDuration / 60
            val s = recordingDuration % 60
            val durStr = String.format("%d:%02d / 2:00", m, s)

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Color(0xFFEF4444))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(modifier = Modifier.size(10.dp).background(Color.White, CircleShape))
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Vocal Ghost: $durStr", color = Color.White, fontWeight = FontWeight.Black, fontSize = 13.sp)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { onStopRecording(true) }) {
                        Text("Annuler", color = Color.White.copy(alpha = 0.8f), fontWeight = FontWeight.Bold)
                    }
                    Button(
                        onClick = { onStopRecording(false) },
                        colors = ButtonDefaults.buttonColors(containerColor = Color.White, contentColor = Color(0xFFEF4444))
                    ) {
                        Text("Envoyer", fontWeight = FontWeight.Black)
                    }
                }
            }
        }
        
        // Input Footer
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .background(Color.White)
                .border(1.dp, Color(0xFFF3F4F6))
                .padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Microphone Button for Ghost Voice
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .background(if (isRecording) Color(0xFFEF4444) else Color(0xFFF5F3FF), RoundedCornerShape(16.dp))
                    .clickable {
                        if (!isRecording) onStartRecording() else onStopRecording(false)
                    },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    TablerIcons.Microphone,
                    contentDescription = "Voice",
                    tint = if (isRecording) Color.White else Color(0xFF7C3AED),
                    modifier = Modifier.size(20.dp)
                )
            }

            Spacer(modifier = Modifier.width(8.dp))

            Box(
                modifier = Modifier
                    .weight(1f)
                    .background(Color.White, RoundedCornerShape(28.dp))
                    .border(2.dp, InputBorder, RoundedCornerShape(28.dp))
                    .padding(horizontal = 16.dp, vertical = 12.dp)
            ) {
                BasicTextField(
                    value = inputText,
                    onValueChange = { inputText = it },
                    textStyle = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Bold, color = TextDark),
                    modifier = Modifier.fillMaxWidth(),
                    decorationBox = { innerTextField ->
                        if (inputText.isEmpty()) Text("Tape ton message...", color = Color(0xFF9CA3AF), fontSize = 14.sp, fontWeight = FontWeight.Bold)
                        innerTextField()
                    }
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
            Box(
                modifier = Modifier
                    .size(44.dp)
                    .background(BrandGradient, RoundedCornerShape(16.dp))
                    .clickable {
                        onSendMessage(inputText)
                        inputText = ""
                    },
                contentAlignment = Alignment.Center
            ) {
                Icon(TablerIcons.Send, contentDescription = "Send", tint = Color.White, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
fun GhostVoiceBubble(msg: GhostMessage, isMe: Boolean) {
    var isPlaying by remember { mutableStateOf(false) }
    var mediaPlayer by remember { mutableStateOf<MediaPlayer?>(null) }
    var remainingSeconds by remember { mutableStateOf(300 - ((System.currentTimeMillis() - msg.createdAt) / 1000).toInt()) }

    LaunchedEffect(msg.id) {
        while (remainingSeconds > 0) {
            delay(1000)
            remainingSeconds = (300 - ((System.currentTimeMillis() - msg.createdAt) / 1000)).toInt()
        }
    }

    val m = msg.durationSeconds / 60
    val s = msg.durationSeconds % 60
    val durStr = String.format("%d:%02d", m, s)

    val expM = (remainingSeconds.coerceAtLeast(0)) / 60
    val expS = (remainingSeconds.coerceAtLeast(0)) % 60
    val expStr = String.format(" Disparaît dans %d:%02d", expM, expS)

    DisposableEffect(msg.id) {
        onDispose {
            mediaPlayer?.release()
            mediaPlayer = null
        }
    }

    Box(
        modifier = Modifier
            .fillMaxWidth(0.82f)
            .background(
                if (isMe) BrandGradient else Brush.linearGradient(listOf(BubbleRecv, BubbleRecv)),
                shape = if (isMe) RoundedCornerShape(22.dp, 22.dp, 4.dp, 22.dp) else RoundedCornerShape(22.dp, 22.dp, 22.dp, 4.dp)
            )
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(38.dp)
                    .background(if (isMe) Color.White.copy(alpha = 0.25f) else Color(0xFF7C3AED).copy(alpha = 0.15f), CircleShape)
                    .clickable {
                        if (isPlaying) {
                            mediaPlayer?.pause()
                            isPlaying = false
                        } else {
                            try {
                                if (mediaPlayer == null) {
                                    mediaPlayer = MediaPlayer().apply {
                                        setDataSource(msg.content)
                                        prepare()
                                        setOnCompletionListener {
                                            isPlaying = false
                                        }
                                    }
                                }
                                mediaPlayer?.start()
                                isPlaying = true
                            } catch (e: Exception) {
                                e.printStackTrace()
                            }
                        }
                    },
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    if (isPlaying) TablerIcons.PlayerPause else TablerIcons.PlayerPlay,
                    contentDescription = null,
                    tint = if (isMe) Color.White else Color(0xFF7C3AED),
                    modifier = Modifier.size(18.dp)
                )
            }
            Spacer(modifier = Modifier.width(12.dp))
            Column {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Message Vocal", fontSize = 13.sp, fontWeight = FontWeight.Black, color = if (isMe) Color.White else TextDark)
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(durStr, fontSize = 11.sp, fontWeight = FontWeight.Bold, color = if (isMe) Color.White.copy(alpha = 0.8f) else TextGray)
                }
                Spacer(modifier = Modifier.height(2.dp))
                Text(expStr, fontSize = 9.sp, fontWeight = FontWeight.Black, color = if (isMe) Color(0xFFFDE68A) else Color(0xFFF59E0B))
            }
        }
    }
}

@Composable
fun PanicCalculatorScreen(onUnlock: () -> Unit) {
    var display by remember { mutableStateOf("0") }
    var expression by remember { mutableStateOf("") }
    var clearOnNext by remember { mutableStateOf(false) }

    fun onNum(n: String) {
        if (display == "0" || clearOnNext) {
            display = n
            clearOnNext = false
        } else {
            display += n
        }
    }

    fun onOp(op: String) {
        expression = "$display $op "
        clearOnNext = true
    }

    fun onEqual() {
        if (display == "1234" || display == "0000") {
            onUnlock()
            return
        }
        try {
            if (expression.isNotEmpty()) {
                val parts = expression.trim().split(" ")
                val num1 = parts[0].toDoubleOrNull() ?: 0.0
                val op = parts[1]
                val num2 = display.toDoubleOrNull() ?: 0.0
                val res = when (op) {
                    "+" -> num1 + num2
                    "-" -> num1 - num2
                    "×" -> num1 * num2
                    "÷" -> if (num2 != 0.0) num1 / num2 else 0.0
                    else -> num2
                }
                display = if (res % 1.0 == 0.0) res.toLong().toString() else String.format(java.util.Locale.US, "%.2f", res)
                expression = ""
                clearOnNext = true
            }
        } catch (e: Exception) {
            display = "Erreur"
            clearOnNext = true
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF1E1E2E))
            .padding(20.dp),
        verticalArrangement = Arrangement.SpaceBetween
    ) {
        // Top discreet exit icon
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text("Calculatrice", color = Color.Gray, fontSize = 14.sp, fontWeight = FontWeight.Bold)
            IconButton(onClick = onUnlock) {
                Icon(TablerIcons.Lock, contentDescription = "Exit Panic Mode", tint = Color(0xFF475569), modifier = Modifier.size(20.dp))
            }
        }

        // Display
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 24.dp),
            horizontalAlignment = Alignment.End
        ) {
            Text(expression, color = Color.Gray, fontSize = 18.sp, fontWeight = FontWeight.Medium)
            Spacer(modifier = Modifier.height(8.dp))
            Text(display, color = Color.White, fontSize = 46.sp, fontWeight = FontWeight.Bold, maxLines = 1)
        }

        // Buttons Grid
        val buttonRows = listOf(
            listOf("C" to Color(0xFFEF4444), "±" to Color(0xFF475569), "%" to Color(0xFF475569), "÷" to Color(0xFFF59E0B)),
            listOf("7" to Color(0xFF334155), "8" to Color(0xFF334155), "9" to Color(0xFF334155), "×" to Color(0xFFF59E0B)),
            listOf("4" to Color(0xFF334155), "5" to Color(0xFF334155), "6" to Color(0xFF334155), "-" to Color(0xFFF59E0B)),
            listOf("1" to Color(0xFF334155), "2" to Color(0xFF334155), "3" to Color(0xFF334155), "+" to Color(0xFFF59E0B)),
            listOf("0" to Color(0xFF334155), "." to Color(0xFF334155), "DEL" to Color(0xFF475569), "=" to Color(0xFF10B981))
        )

        Column(
            modifier = Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            buttonRows.forEach { row ->
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    row.forEach { (label, btnColor) ->
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .height(64.dp)
                                .clip(RoundedCornerShape(18.dp))
                                .background(btnColor)
                                .clickable {
                                    when (label) {
                                        "C" -> { display = "0"; expression = "" }
                                        "DEL" -> {
                                            if (display.length > 1) display = display.dropLast(1)
                                            else display = "0"
                                        }
                                        "±" -> {
                                            if (display.startsWith("-")) display = display.substring(1)
                                            else if (display != "0") display = "-$display"
                                        }
                                        "%" -> {
                                            val v = display.toDoubleOrNull() ?: 0.0
                                            display = (v / 100.0).toString()
                                        }
                                        "+", "-", "×", "÷" -> onOp(label)
                                        "=" -> onEqual()
                                        else -> onNum(label)
                                    }
                                },
                            contentAlignment = Alignment.Center
                        ) {
                            Text(label, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}
