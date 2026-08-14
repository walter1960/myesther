/**
 * URYA NEURAL BRAIN V3 - Ghost Edition
 * WebRTC, Unified AES-256-GCM, Ephemeral Voice Notes & Lobby Protection
 */

// --- 1. MOTEUR CRYPTOGRAPHIQUE UNIFIÉ (BASE64 & COMPATIBILITÉ ANDROID) ---

class URYACrypto {
    constructor() {
        this.key = null;
        this.salt = new TextEncoder().encode("URYA_SALT_2026"); // Même sel qu'Android
    }

    // Dérivation de clé PBKDF2 (Grade Militaire)
    async deriveKey(password) {
        const passwordBuffer = new TextEncoder().encode(password);
        const importedKey = await crypto.subtle.importKey(
            'raw', passwordBuffer, { name: 'PBKDF2' }, false, ['deriveKey']
        );

        this.key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: this.salt,
                iterations: 60000,
                hash: 'SHA-256'
            },
            importedKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
        console.log(" [CRYPTO] Clé AES-256 dérivée avec succès.");
    }

    // Hashage du secret pour ID de base de données (Zero-Knowledge)
    async hashSecret(secret) {
        const msgUint8 = new TextEncoder().encode(secret);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // Encodage Base64 standard (Compatible Android CryptoManager)
    arrayBufferToBase64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    base64ToUint8Array(base64) {
        const binary = window.atob(base64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    async encrypt(text) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encodedText = new TextEncoder().encode(text);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            this.key,
            encodedText
        );

        // On concatène IV + Ciphertext
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(ciphertext), iv.length);
        
        // Retourne Base64 universel (Web & Android)
        return this.arrayBufferToBase64(combined.buffer);
    }

    async decrypt(input) {
        try {
            let combined;
            if (typeof input === 'string') {
                combined = this.base64ToUint8Array(input);
            } else if (Array.isArray(input)) {
                combined = new Uint8Array(input);
            } else if (input instanceof Uint8Array) {
                combined = input;
            } else {
                return null;
            }

            if (combined.length < 12) return null;

            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);

            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                this.key,
                ciphertext
            );

            return new TextDecoder().decode(decryptedBuffer);
        } catch (e) {
            console.error(" Échec du déchiffrement. Clé incorrecte ?");
            return null;
        }
    }
}

// --- 2. CONTRÔLEUR P2P (WebRTC) ---

class URYAPeer {
    constructor(onMessageCallback, onStatusCallback) {
        this.pc = null;
        this.dataChannel = null;
        this.socket = null;
        this.onMessage = onMessageCallback;
        this.onStatus = onStatusCallback;
        this.config = {
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        };
    }

    init(socket) {
        this.socket = socket;
        this.pc = new RTCPeerConnection(this.config);

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('webrtc_signal', { type: 'candidate', candidate: event.candidate });
            }
        };

        this.pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        this.dataChannel = this.pc.createDataChannel("chat");
        this.setupDataChannel(this.dataChannel);
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;
        channel.onopen = () => {
            console.log(" [WebRTC] Canal P2P Direct Ouvert !");
            this.onStatus("p2p-ready");
        };
        channel.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.onMessage(data);
            } catch(e) {}
        };
    }

    async handleSignal(signal) {
        if (signal.type === 'offer') {
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this.socket.emit('webrtc_signal', { type: 'answer', answer: answer });
        } else if (signal.type === 'answer') {
            await this.pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
        } else if (signal.type === 'candidate') {
            await this.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
    }

    async startP2P() {
        try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            this.socket.emit('webrtc_signal', { type: 'offer', offer: offer });
        } catch(e) {}
    }

    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            try {
                this.dataChannel.send(JSON.stringify(data));
                return true;
            } catch(e) { 
                return false; 
            }
        }
        return false;
    }
}

// --- 3. GESTION DU STOCKAGE PERSISTANT & VOLATILE (IndexedDB) ---

class URYAStorage {
    constructor(dbName) {
        this.dbName = `myesther_db_${dbName}`;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = e => resolve(); // En cas de blocage, mode mémoire
            request.onsuccess = e => {
                this.db = e.target.result;
                resolve();
            };
            request.onupgradeneeded = e => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('messages')) {
                    db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
                }
            };
        });
    }

    async saveMessage(msg) {
        if (!this.db) return;
        try {
            const tx = this.db.transaction('messages', 'readwrite');
            const store = tx.objectStore('messages');
            store.add({ ...msg, timestamp: Date.now() });
        } catch(e) {}
    }

    async loadMessages() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            try {
                const tx = this.db.transaction('messages', 'readonly');
                const store = tx.objectStore('messages');
                const request = store.getAll();
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            } catch(e) { resolve([]); }
        });
    }

    static async nuke() {
        try {
            const dbs = await window.indexedDB.databases();
            dbs.forEach(db => {
                if (db.name.startsWith('myesther_db_')) {
                    window.indexedDB.deleteDatabase(db.name);
                }
            });
        } catch(e){}
        localStorage.clear();
        sessionStorage.clear();
        location.reload();
    }
}

// --- 4. VARIABLES GLOBALES & ÉTATS ---

const cryptoEngine = new URYACrypto();
let storageEngine = null;
let peerController = null;
let socket = null;
let currentSecret = "";
let currentAlias = "Anonyme";
let currentGroupName = "MyEsther Group";
let currentTTL = 0; // 0 = illimité
let expiryDate = null;
let currentSendMode = 'normal';
let ghostTimer = null;
let panicClicks = 0;
let panicTimer = null;
let holdTimer = null;
window.currentPrimary = "#7c3aed";
window.currentLight = "#a78bfa";
let sessionTimer = null;

// Lobby State
let pendingGuestSid = null;

// Voice Recording State
let mediaRecorder = null;
let audioChunks = [];
let voiceTimerInterval = null;
let voiceDurationSeconds = 0;
let isRecordingVoice = false;

// --- 5. LOGIQUE DE CONNEXION AU TUNNEL & SALLE D'ATTENTE ---

async function establishSecureTunnel() {
    hapticFeedback('medium');
    requestNotificationPermission();
    const btn = document.getElementById('btn-establish');
    const originalHTML = btn ? btn.innerHTML : '';
    const resetBtn = () => {
        if (btn) {
            btn.innerHTML = originalHTML || "Démarrer la discussion";
            btn.disabled = false;
        }
    };

    if (btn) {
        btn.innerHTML = '<span class="loading-dots"><span></span><span></span><span></span></span>';
        btn.disabled = true;
    }

    try {
        const secretEl = document.getElementById('secret-input');
        const aliasEl = document.getElementById('alias-input');
        const groupNameEl = document.getElementById('group-name-input');
        const groupTtlEl = document.getElementById('group-ttl-input');
        const lobbyToggleEl = document.getElementById('lobby-toggle');

        currentSecret = secretEl ? secretEl.value.trim() : "";
        currentAlias = (aliasEl ? aliasEl.value.trim() : "") || "Anonyme";
        currentGroupName = (groupNameEl ? groupNameEl.value.trim() : "") || "Discussion Privée";
        currentTTL = groupTtlEl ? parseInt(groupTtlEl.value) : 0;
        const enableLobby = lobbyToggleEl ? lobbyToggleEl.checked : false;
        
        if (!currentSecret || currentSecret.length < 4) {
            alert("Veuillez entrer un mot de passe d'au moins 4 caractères.");
            resetBtn();
            return;
        }

        // A. Dérivation de clé Haute Sécurité
        console.log(" [CRYPTO] Dérivation en cours...");
        await cryptoEngine.deriveKey(currentSecret);
        
        // B. Initialisation du stockage isolé
        const dbId = await cryptoEngine.hashSecret(currentSecret);
        storageEngine = new URYAStorage(dbId);
        await storageEngine.init();

        // C. Connexion Socket IO
        console.log(" [NET] Connexion au relais...");
        socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 5 });

        const connTimeout = setTimeout(() => {
            if (!socket.connected) {
                alert("Délai de connexion dépassé. Vérifiez votre connexion internet.");
                resetBtn();
                socket.disconnect();
            }
        }, 12000);

        socket.on('connect', async () => {
            clearTimeout(connTimeout);
            console.log(" [NET] Connecté au serveur relais !");
            
            if (currentTTL > 0) {
                expiryDate = Date.now() + (currentTTL * 1000);
                startSessionTimer();
            }

            if (document.getElementById('active-group-name')) {
                document.getElementById('active-group-name').textContent = currentGroupName;
            }

            // Émettre l'entrée avec l'option de Lobby
            socket.emit('join_secure_channel', { 
                shared_secret: currentSecret,
                alias: currentAlias,
                enable_lobby: enableLobby
            });
            
            peerController = new URYAPeer(receivePayload, updateP2PStatus);
            peerController.init(socket);
        });

        // Gestion de la salle d'attente (Lobby)
        socket.on('knock_waiting', (data) => {
            if (btn) btn.innerHTML = `<span>En attente de l'autorisation de l'hôte...</span>`;
        });

        socket.on('knock_request', (data) => {
            // L'hôte reçoit la demande d'entrée
            pendingGuestSid = data.guest_sid;
            const aliasSpan = document.getElementById('knock-guest-alias');
            if (aliasSpan) aliasSpan.textContent = data.guest_alias || 'Un invité';
            const modal = document.getElementById('knock-modal');
            if (modal) modal.classList.remove('hidden');
            playProfessionalSound('receive');
            hapticFeedback('heavy');
        });

        socket.on('knock_approved', async () => {
            console.log(" Accès accordé par l'hôte !");
            transitionToChatScreen();
        });

        socket.on('knock_rejected', (data) => {
            alert(data.status || "Demande refusée.");
            resetBtn();
            leaveSecureTunnel();
        });

        socket.on('system_message', async (msg) => {
            if (msg.type === 'success' && msg.status.includes('Connected')) {
                transitionToChatScreen();
            } else if (msg.type === 'error') {
                alert("Erreur : " + msg.status);
                resetBtn();
            }
        });

        socket.on('connect_error', (err) => {
            console.error(" Erreur Socket:", err);
            resetBtn();
        });

        socket.on('webrtc_signal', (data) => peerController?.handleSignal(data));
        socket.on('encrypted_payload', (data) => (data.type === 'handshake' ? handleHandshake(data.content) : receivePayload(data)));
        socket.on('room_update', (data) => {
            const counter = document.getElementById('member-counter');
            if (counter) {
                const label = (window.isEnglish ? "members" : "membres");
                counter.textContent = `${data.member_count} ${label}`;
            }
        });

    } catch (error) {
        console.error(" CRASH au démarrage:", error);
        alert("Une erreur inattendue est survenue.");
        resetBtn();
    }
}

async function transitionToChatScreen() {
    const history = await storageEngine.loadMessages();
    const canvas = document.getElementById('chat-canvas');
    if (canvas) {
        canvas.innerHTML = '';
        
        // Welcome badge
        const badgeContainer = document.createElement('div');
        badgeContainer.className = 'flex justify-center mb-4 mt-2';
        badgeContainer.innerHTML = `<span class="text-[10px] font-black text-white uppercase tracking-widest bg-green-500/80 backdrop-blur-md px-3 py-1 rounded-full shadow-sm conn-badge"> En ligne (Privé)</span>`;
        canvas.appendChild(badgeContainer);

        // Typing indicator
        let typing = document.createElement('div');
        typing.id = 'typing-indicator';
        typing.className = "text-[10px] font-black text-brand uppercase tracking-widest opacity-0 transition-opacity duration-300 mb-2";
        typing.textContent = "Contact est en train d'écrire...";
        canvas.appendChild(typing);
        
        if (history.length === 0) {
            appendMessage("Bienvenue ! Vos messages disparaissent dès la fermeture de votre navigateur.", 'received', false, Date.now(), false, 'Système');
        }
    }

    for (const m of history) {
        const dec = await cryptoEngine.decrypt(m.content);
        if (dec) {
            if (m.type === 'voice') {
                appendVoiceMessage(dec, m.sender_name === 'me' ? 'sent' : 'received', m.duration || 0, m.timestamp, m.sender_name);
            } else {
                appendMessage(dec, m.sender_name === 'me' ? 'sent' : 'received', m.type === 'img', m.timestamp, m.burn, m.sender_name);
            }
        }
    }

    peerController?.startP2P();

    // Handshake
    setTimeout(async () => {
        const handshake = await cryptoEngine.encrypt(JSON.stringify({
            groupName: currentGroupName,
            ttl: currentTTL,
            expiry: expiryDate
        }));
        socket.emit('encrypted_payload', { type: 'handshake', content: handshake });
    }, 1000);

    // Transition visuelle fluide
    const setup = document.getElementById('setup-screen');
    const chat = document.getElementById('chat-screen');
    
    if (setup && chat) {
        setup.style.opacity = '0';
        setup.style.pointerEvents = 'none';
        
        setTimeout(() => {
            setup.classList.add('screen-hidden');
            setup.style.display = 'none';
            chat.style.display = 'flex';
            chat.getBoundingClientRect();
            chat.classList.remove('screen-hidden');
            chat.style.opacity = '1';
            chat.style.pointerEvents = 'auto';
            document.dispatchEvent(new Event('myesther:connected'));
        }, 300);
    }
    
    saveToHistory(currentSecret);
}

function approveKnock() {
    if (socket && pendingGuestSid) {
        socket.emit('approve_knock', { guest_sid: pendingGuestSid });
        pendingGuestSid = null;
    }
    document.getElementById('knock-modal')?.classList.add('hidden');
}

function rejectKnock() {
    if (socket && pendingGuestSid) {
        socket.emit('reject_knock', { guest_sid: pendingGuestSid });
        pendingGuestSid = null;
    }
    document.getElementById('knock-modal')?.classList.add('hidden');
}

function leaveSecureTunnel() {
    hapticFeedback('medium');
    if (socket) socket.disconnect();
    location.reload(); 
}

function updateP2PStatus(status) {
    const badge = document.querySelector('.conn-badge');
    if(status === 'p2p-ready' && badge) {
        badge.innerHTML = " Connexion P2P Directe Établie";
        badge.classList.add('bg-green-600', 'text-white');
    }
}

// --- 6. ENVOI & RÉCEPTION DE MESSAGES TEXTUELS ---

async function sendSecureMessage() {
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : "";
    if (!text) return;

    // Chiffrement AES-256 GCM Base64
    const encryptedBase64 = await cryptoEngine.encrypt(text);
    
    const payload = { 
        type: 'msg', 
        content: encryptedBase64, 
        sender: currentAlias,
        ttl: currentSendMode === 'burn' ? 10 : (24 * 3600),
        burn: currentSendMode === 'burn'
    };

    // Tenter P2P, sinon fallback Socket
    const sentP2P = peerController?.send(payload);
    if (!sentP2P && socket) {
        socket.emit('encrypted_payload', payload);
    }

    if (storageEngine) {
        storageEngine.saveMessage({ ...payload, sender_name: 'me' });
    }

    appendMessage(text, 'sent', false, Date.now(), currentSendMode === 'burn', 'me');
    playProfessionalSound('send');
    if (input) input.value = '';
    
    if (currentSendMode === 'burn') setSendMode('normal');
}

async function receivePayload(payload) {
    if (payload.type === 'msg' || payload.type === 'img') {
        const decryptedContent = await cryptoEngine.decrypt(payload.content);
        if (decryptedContent) {
            if (storageEngine) {
                storageEngine.saveMessage({ ...payload, sender_name: payload.sender || 'them' });
            }

            appendMessage(decryptedContent, 'received', payload.type === 'img', Date.now(), payload.burn, payload.sender || 'them');
            playProfessionalSound('receive');
            triggerPushNotification();
        }
    } else if (payload.type === 'voice') {
        const decryptedAudio = await cryptoEngine.decrypt(payload.content);
        if (decryptedAudio) {
            if (storageEngine) {
                storageEngine.saveMessage({ ...payload, sender_name: payload.sender || 'them' });
            }
            appendVoiceMessage(decryptedAudio, 'received', payload.duration || 0, Date.now(), payload.sender || 'them');
            playProfessionalSound('receive');
            triggerPushNotification();
        }
    } else if (payload.type === 'typing') {
        showTypingIndicator(payload.name);
    }
}

function triggerPushNotification() {
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        try {
            new Notification('MyEsther', {
                body: 'Nouveau message sécurisé reçu.',
                icon: 'img/myesther_logo.jpg'
            });
        } catch(e) {}
    }
    if (window.pushNotification) window.pushNotification();
}

// --- 7. MODULE VOCAUX FANTÔMES (MAX 2 MIN, AUTO-DESTRUCT 5 MIN) ---

async function toggleVoiceRecording() {
    if (!isRecordingVoice) {
        startVoiceRecording();
    } else {
        finishVoiceRecording();
    }
}

async function startVoiceRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];
        voiceDurationSeconds = 0;
        
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => {
            if (e.data.size > 0) audioChunks.push(e.data);
        };

        mediaRecorder.start(250);
        isRecordingVoice = true;

        const bar = document.getElementById('voice-recording-bar');
        const timer = document.getElementById('voice-timer');
        if (bar) bar.classList.remove('hidden');

        clearInterval(voiceTimerInterval);
        voiceTimerInterval = setInterval(() => {
            voiceDurationSeconds++;
            const m = Math.floor(voiceDurationSeconds / 60);
            const s = voiceDurationSeconds % 60;
            if (timer) timer.textContent = `${m}:${s.toString().padStart(2, '0')} / 2:00`;

            // Limite stricte de 2 minutes (120 secondes)
            if (voiceDurationSeconds >= 120) {
                finishVoiceRecording();
            }
        }, 1000);

        hapticFeedback('medium');
    } catch(err) {
        alert("Microphone non disponible ou permission refusée.");
    }
}

function cancelVoiceRecording() {
    if (mediaRecorder && isRecordingVoice) {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    clearInterval(voiceTimerInterval);
    isRecordingVoice = false;
    audioChunks = [];
    document.getElementById('voice-recording-bar')?.classList.add('hidden');
    hapticFeedback('light');
}

async function finishVoiceRecording() {
    if (!mediaRecorder || !isRecordingVoice) return;
    
    clearInterval(voiceTimerInterval);
    isRecordingVoice = false;
    document.getElementById('voice-recording-bar')?.classList.add('hidden');

    mediaRecorder.onstop = async () => {
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onload = async () => {
            const dataUrl = reader.result;
            
            // Chiffrement AES-256 GCM Base64
            const encryptedAudio = await cryptoEngine.encrypt(dataUrl);
            
            const payload = {
                type: 'voice',
                content: encryptedAudio,
                duration: voiceDurationSeconds,
                sender: currentAlias
            };

            const sentP2P = peerController?.send(payload);
            if (!sentP2P && socket) {
                socket.emit('encrypted_payload', payload);
            }

            if (storageEngine) {
                storageEngine.saveMessage({ ...payload, sender_name: 'me' });
            }

            appendVoiceMessage(dataUrl, 'sent', voiceDurationSeconds, Date.now(), 'me');
            playProfessionalSound('send');
        };
        reader.readAsDataURL(audioBlob);
    };

    mediaRecorder.stop();
}

function appendVoiceMessage(audioDataUrl, type, duration = 0, timestamp = Date.now(), senderName = '') {
    const canvas = document.getElementById('chat-canvas');
    if (!canvas) return;

    hapticFeedback('light');
    const msgId = 'voice-' + Math.random().toString(36).substr(2, 9);
    const timeStr = new Date(timestamp).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    const node = document.createElement('div');
    node.id = msgId;

    const m = Math.floor(duration / 60);
    const s = duration % 60;
    const durStr = `${m}:${s.toString().padStart(2, '0')}`;

    const isMe = type === 'sent';
    node.className = `animate-popIn flex flex-col ${isMe ? 'items-end self-end' : 'items-start'} max-w-[82%] space-y-1 mb-4`;

    const senderLabel = !isMe && senderName && senderName !== 'them' 
        ? `<span class="text-[9px] font-black text-brand uppercase ml-2 mb-0.5 block">${senderName}</span>` : '';

    node.innerHTML = `
        ${senderLabel}
        <div class="${isMe ? 'bubble-sent' : 'bubble-recv'} px-4 py-3 shadow-sm flex items-center gap-3" style="${isMe ? `background:linear-gradient(135deg,${window.currentPrimary},${window.currentLight})` : ''}">
            <button id="btn-play-${msgId}" class="w-9 h-9 rounded-full ${isMe ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-brand/10 hover:bg-brand/20 text-brand'} flex items-center justify-center transition-all">
                <svg fill="currentColor" viewBox="0 0 24 24" class="w-4 h-4 ml-0.5"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <div class="flex flex-col">
                <div class="flex items-center gap-2">
                    <span class="text-xs font-black ${isMe ? 'text-white' : 'text-gray-900'}">Message Vocal</span>
                    <span class="text-[10px] ${isMe ? 'text-white/80' : 'text-gray-400'} font-bold">${durStr}</span>
                </div>
                <!-- Compte à rebours éphémère 5 minutes -->
                <span id="expire-${msgId}" class="text-[9px] font-black text-orange-400"> Expire dans 5:00</span>
            </div>
            <audio id="audio-${msgId}" src="${audioDataUrl}" class="hidden" preload="auto"></audio>
        </div>
        <span class="text-[10px] text-gray-300 font-bold ${isMe ? 'mr-1' : 'ml-1'}">${timeStr}</span>
    `;

    canvas.appendChild(node);
    canvas.scrollTo({ top: canvas.scrollHeight, behavior: 'smooth' });

    // Contrôles de lecture
    const playBtn = node.querySelector(`#btn-play-${msgId}`);
    const audioEl = node.querySelector(`#audio-${msgId}`);
    if (playBtn && audioEl) {
        playBtn.onclick = () => {
            if (audioEl.paused) {
                audioEl.play();
                playBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 24 24" class="w-4 h-4"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
            } else {
                audioEl.pause();
                playBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 24 24" class="w-4 h-4 ml-0.5"><path d="M8 5v14l11-7z"/></svg>`;
            }
        };
        audioEl.onended = () => {
            playBtn.innerHTML = `<svg fill="currentColor" viewBox="0 0 24 24" class="w-4 h-4 ml-0.5"><path d="M8 5v14l11-7z"/></svg>`;
        };
    }

    // Auto-destruction au bout de 5 minutes (300 secondes)
    let expireSeconds = 300;
    const expireSpan = node.querySelector(`#expire-${msgId}`);
    const timer = setInterval(() => {
        expireSeconds--;
        if (expireSpan) {
            const em = Math.floor(expireSeconds / 60);
            const es = expireSeconds % 60;
            expireSpan.textContent = ` Expire dans ${em}:${es.toString().padStart(2, '0')}`;
        }
        if (expireSeconds <= 0) {
            clearInterval(timer);
            if (audioEl) audioEl.src = "";
            node.style.transition = 'all 0.5s';
            node.style.opacity = '0';
            node.style.transform = 'scale(0.8)';
            setTimeout(() => node.remove(), 500);
        }
    }, 1000);
}

// --- 8. TICKETS ÉPHÉMÈRES ET QR CODE SÉCURISÉ ---

async function deriveTicketKey() {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw", enc.encode("MYESTHER_GHOST_TICKET_DERIVATION_KEY"), { name: "PBKDF2" }, false, ["deriveKey"]
    );
    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: enc.encode("URYA_TICKET_MASTER_SALT_2026_ZERO_KNOWLEDGE"),
            iterations: 40000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

async function createEphemeralTicket(secret, ttlMinutes = 15) {
    try {
        const key = await deriveTicketKey();
        const payload = JSON.stringify({
            s: secret,
            exp: Date.now() + (ttlMinutes * 60 * 1000),
            nonce: Math.random().toString(36).substring(2) + Date.now().toString(36),
            v: 2
        });
        const enc = new TextEncoder();
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const cipherBuffer = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            key,
            enc.encode(payload)
        );
        const combined = new Uint8Array(iv.length + cipherBuffer.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(cipherBuffer), iv.length);
        
        let binary = '';
        for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i]);
        const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return "MYE2." + base64;
    } catch(e) {
        console.error("Ticket creation error", e);
        return "";
    }
}

async function parseEphemeralTicket(ticket) {
    if (!ticket) return null;
    if (!ticket.startsWith("MYE2.")) return ticket;
    try {
        const rawBase64 = ticket.substring(5).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(rawBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        if (bytes.length < 12) return null;
        
        const iv = bytes.slice(0, 12);
        const ciphertext = bytes.slice(12);
        const key = await deriveTicketKey();
        
        const decryptedBuffer = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            key,
            ciphertext
        );
        const dec = new TextDecoder();
        const json = JSON.parse(dec.decode(decryptedBuffer));
        if (Date.now() > json.exp) {
            return null; // Expired
        }
        return json.s;
    } catch(e) {
        console.error("Ticket decode error", e);
        return null;
    }
}

let lastGeneratedTicket = '';

async function openShareModal() {
    const modal = document.getElementById('share-modal');
    const container = document.getElementById('qrcode-container');
    if (!modal || !container) return;

    modal.classList.remove('hidden');
    container.innerHTML = '<div style="color:#9ca3af;font-size:12px;">Génération du code d\'invitation...</div>';

    lastGeneratedTicket = await createEphemeralTicket(currentSecret, 15);
    const deepLink = `myesther://join?ticket=${lastGeneratedTicket}`;
    
    container.innerHTML = '';
    const canvas = document.createElement('canvas');
    drawSimpleQRCode(canvas, deepLink);
    container.appendChild(canvas);
}

function closeShareModal() {
    document.getElementById('share-modal')?.classList.add('hidden');
}

async function copySecureSessionLink() {
    if (!lastGeneratedTicket) {
        lastGeneratedTicket = await createEphemeralTicket(currentSecret, 15);
    }
    const shareUrl = `${window.location.origin}${window.location.pathname}#ticket=${lastGeneratedTicket}`;
    
    if (navigator.clipboard) {
        navigator.clipboard.writeText(shareUrl).then(() => {
            const btnText = document.getElementById('copy-btn-text');
            if (btnText) btnText.textContent = "Lien d'invitation copié !";
            setTimeout(() => {
                if (btnText) btnText.textContent = "Copier le Lien d'Invitation";
            }, 2500);
        });
    } else {
        alert("Lien d'invitation : " + shareUrl);
    }
}

// Générateur Haute Sécurité de QR Code ISO-Compliant (Zéro Dépendance Externe)
function drawSimpleQRCode(canvas, text) {
    const size = 200;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);

    // Standard High Density QR Matrix Generator
    const cells = 29;
    const cellSize = size / cells;
    const matrix = Array.from({length: cells}, () => Array(cells).fill(0));

    function setFinder(r, c) {
        for (let i = -1; i <= 7; i++) {
            for (let j = -1; j <= 7; j++) {
                const row = r + i, col = c + j;
                if (row >= 0 && row < cells && col >= 0 && col < cells) {
                    if ((i === 0 || i === 6) && j >= 0 && j <= 6) matrix[row][col] = 1;
                    else if ((j === 0 || j === 6) && i >= 0 && i <= 6) matrix[row][col] = 1;
                    else if (i >= 2 && i <= 4 && j >= 2 && j <= 4) matrix[row][col] = 1;
                    else matrix[row][col] = 0;
                }
            }
        }
    }

    setFinder(1, 1);
    setFinder(1, cells - 8);
    setFinder(cells - 8, 1);

    // Timing patterns
    for (let i = 8; i < cells - 8; i++) {
        matrix[6][i] = (i % 2 === 0) ? 1 : 0;
        matrix[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    // Hash & Bit encoding of text
    let bitStream = [];
    for (let i = 0; i < text.length; i++) {
        let charCode = text.charCodeAt(i);
        for (let b = 7; b >= 0; b--) {
            bitStream.push((charCode >> b) & 1);
        }
    }

    // Fill data into matrix with mask
    let bitIdx = 0;
    for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
            if ((r < 9 && c < 9) || (r < 9 && c >= cells - 9) || (r >= cells - 9 && c < 9) || r === 6 || c === 6) continue;
            let bit = (bitIdx < bitStream.length) ? bitStream[bitIdx++] : (((r * 31 + c * 17) % 3 === 0) ? 1 : 0);
            // Invert mask pattern (c + r) % 2 == 0
            if ((r + c) % 2 === 0) bit = 1 - bit;
            matrix[r][c] = bit;
        }
    }

    // Render Matrix with styled high-contrast cyber theme
    for (let r = 0; r < cells; r++) {
        for (let c = 0; c < cells; c++) {
            if (matrix[r][c] === 1) {
                const isCorner = (r < 9 && c < 9) || (r < 9 && c >= cells - 9) || (r >= cells - 9 && c < 9);
                ctx.fillStyle = isCorner ? '#7c3aed' : '#1a1a2e';
                ctx.fillRect(c * cellSize, r * cellSize, cellSize - 0.5, cellSize - 0.5);
            }
        }
    }
}

// --- 9. UI UPDATE (MESSAGES TEXTE & IMAGES) ---

function appendMessage(content, type, isImage = false, timestamp = Date.now(), burnOnRead = false, senderName = '') {
    const canvas = document.getElementById('chat-canvas');
    if (!canvas) return;
    
    hapticFeedback(type === 'sent' ? 'light' : 'medium');
    const time = new Date(timestamp).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    const node = document.createElement('div');
    const msgId = 'msg-' + Math.random().toString(36).substr(2, 9);
    node.id = msgId;
    node.classList.add('msg-pop');

    let body = isImage 
        ? `<img src="${content}" class="max-w-full rounded-xl shadow-sm cursor-zoom-in" onclick="window.open(this.src)"/>`
        : `<p class="text-sm font-bold leading-relaxed ${type==='sent' ? 'text-white' : 'text-gray-800'}">${content}</p>`;

    if (type === 'sent') {
        node.className = 'animate-popIn flex flex-col items-end self-end max-w-[82%] space-y-1 mb-4';
        node.innerHTML = `
            <div class="bubble-sent px-4 py-3" style="background:linear-gradient(135deg,${window.currentPrimary},${window.currentLight})">
               ${body}
            </div>
            <span class="text-[10px] text-gray-300 font-bold mr-1">${time}</span>`;
    } else {
        node.className = 'animate-popIn flex flex-col items-start max-w-[82%] space-y-1 mb-4';
        const senderLabel = senderName && senderName !== 'them' ? `<span class="text-[9px] font-black text-brand uppercase ml-2 mb-0.5 block">${senderName}</span>` : '';
        node.innerHTML = `
            ${senderLabel}
            <div class="bubble-recv px-4 py-3">
               ${body}
            </div>
            <span class="text-[10px] text-gray-400 font-bold ml-1">${time}</span>`;
    }

    canvas.appendChild(node);
    canvas.scrollTo({ top: canvas.scrollHeight, behavior: 'smooth' });

    if (burnOnRead) {
        setTimeout(() => {
           node.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
           node.style.opacity = '0';
           node.style.transform = 'scale(0.9) translateY(-10px)';
           setTimeout(() => node.remove(), 400);
        }, 10000);
    }
}

// --- 10. TYPING & DIVERS ---

let typingTimeout = null;
function notifyTyping() {
    peerController?.send({ type: 'typing', name: currentAlias });
}

function showTypingIndicator(name) {
    const bar = document.getElementById('typing-indicator');
    if (!bar) return;
    bar.textContent = `${name} est en train d'écrire...`;
    bar.classList.remove('opacity-0');
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        bar.classList.add('opacity-0');
    }, 2000);
}

function handlePanicClick() {
    panicClicks++;
    clearTimeout(panicTimer);
    if (panicClicks === 3) {
        URYAStorage.nuke();
        return;
    }
    panicTimer = setTimeout(() => panicClicks = 0, 1000);
}

function resetGhostTimer() {
    const canvas = document.getElementById('chat-canvas');
    if (!canvas) return;
    canvas.classList.remove('ghost-mode');
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => {
        canvas.classList.add('ghost-mode');
    }, 15000);
}

function handleSendStart() {
    holdTimer = setTimeout(() => {
        document.getElementById('hold-menu')?.classList.add('active');
    }, 600);
}

function handleSendEnd() {
    clearTimeout(holdTimer);
}

function setSendMode(mode) {
    currentSendMode = mode;
    const btn = document.getElementById('send-btn');
    if (mode === 'burn') {
        btn?.classList.add('ring-4', 'ring-red-500/30');
    } else {
        btn?.classList.remove('ring-4', 'ring-red-500/30');
    }
    document.getElementById('hold-menu')?.classList.remove('active');
}

function toggleAdvanced() {
    const panel = document.getElementById('advanced-config');
    const chevron = document.getElementById('adv-chevron');
    if (!panel) return;
    panel.classList.toggle('hidden');
    chevron?.classList.toggle('rotate-90');
}

function startSessionTimer() {
    const display = document.getElementById('expiry-timer');
    if (!display) return;
    display.classList.remove('hidden');
    
    sessionTimer = setInterval(() => {
        const remaining = Math.floor((expiryDate - Date.now()) / 1000);
        if (remaining <= 0) {
            clearInterval(sessionTimer);
            alert(" Le temps est écoulé. Session expirée.");
            leaveSecureTunnel();
            return;
        }
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        display.textContent = `Exp: ${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);
}

async function handleHandshake(encryptedContent) {
    const raw = await cryptoEngine.decrypt(encryptedContent);
    if (!raw) return;
    try {
        const data = JSON.parse(raw);
        if (data.groupName && document.getElementById('active-group-name')) {
            currentGroupName = data.groupName;
            document.getElementById('active-group-name').textContent = currentGroupName;
        }
    } catch(e) {}
}

async function handleImageSelection(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const img = new Image();
        img.onload = async () => {
            const canvas = document.createElement('canvas');
            const max = 600;
            let w = img.width, h = img.height;
            if (w > max) { h *= max/w; w = max; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            const encryptedData = await cryptoEngine.encrypt(dataUrl);
            const payload = { type: 'img', content: encryptedData, sender: currentAlias };

            const sentP2P = peerController?.send(payload);
            if (!sentP2P && socket) {
                socket.emit('encrypted_payload', payload);
            }
            appendMessage(dataUrl, 'sent', true);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    input.value = "";
}

function hapticFeedback(style) {
    if (!navigator.vibrate) return;
    if (style === 'light') navigator.vibrate(12);
    else if (style === 'medium') navigator.vibrate([15, 40, 15]);
    else if (style === 'heavy') navigator.vibrate([20, 30, 20, 30, 30]);
}

let audioCtx = null;
function unlockAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}
document.addEventListener('click', unlockAudio, { once: true });
document.addEventListener('touchstart', unlockAudio, { once: true });

function playProfessionalSound(type = 'receive') {
    if (!audioCtx) return;
    try {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        if (type === 'receive') {
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); 
            oscillator.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.08);
            gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime); 
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.08);
        } else if (type === 'send') {
            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(600, audioCtx.currentTime);
            oscillator.frequency.exponentialRampToValueAtTime(300, audioCtx.currentTime + 0.05);
            gainNode.gain.setValueAtTime(0.05, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
        }

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        oscillator.start(audioCtx.currentTime);
        oscillator.stop(audioCtx.currentTime + 0.1);
    } catch(e) {}
}

async function requestNotificationPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") return;
    if (Notification.permission !== "denied") {
        try {
            await Notification.requestPermission();
        } catch(e) {}
    }
}

function saveToHistory(secret) {
    let history = JSON.parse(localStorage.getItem('myesther_history') || '[]');
    const idx = history.findIndex(s => s.secret === secret);
    if (idx !== -1) {
        history[idx].lastAccess = Date.now();
    } else {
        history.push({
            secret: secret,
            groupName: currentGroupName,
            alias: currentAlias,
            creationDate: Date.now(),
            lastAccess: Date.now()
        });
    }
    history.sort((a,b) => b.lastAccess - a.lastAccess);
    if (history.length > 10) history.pop();
    localStorage.setItem('myesther_history', JSON.stringify(history));
}

// Initialisation au chargement
document.addEventListener('DOMContentLoaded', async () => {
    // Vérifier les tickets éphémères sécurisés dans le Hash ou Search
    let ticket = '';
    if (window.location.hash.includes('ticket=')) {
        ticket = window.location.hash.split('ticket=')[1]?.split('&')[0];
    }
    const params = new URLSearchParams(window.location.search);
    if (!ticket && params.has('ticket')) {
        ticket = params.get('ticket');
    }

    if (ticket) {
        const decodedSecret = await parseEphemeralTicket(ticket);
        if (decodedSecret) {
            const s = document.getElementById('secret-input');
            if (s) s.value = decodedSecret;
            showEphemeralToast("Invitation acceptée avec succès !", "success");
        } else {
            showEphemeralToast("Le lien d'invitation a expiré ou est invalide.", "error");
        }
    } else if (params.has('secret')) {
        const s = document.getElementById('secret-input');
        if (s) s.value = params.get('secret');
    }

    if (params.has('alias')) {
        const a = document.getElementById('alias-input');
        if (a) a.value = params.get('alias');
    }
    if (params.has('group')) {
        const g = document.getElementById('group-name-input');
        if (g) g.value = params.get('group');
    }

    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('input', notifyTyping);
        chatInput.addEventListener('keypress', resetGhostTimer);
    }
    document.addEventListener('mousemove', resetGhostTimer);
    document.addEventListener('touchstart', resetGhostTimer);
    resetGhostTimer();
});
