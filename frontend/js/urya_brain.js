/**
 * URYA NEURAL BRAIN V2 - WebRTC & AES-GCM Edition
 * High-Security Cryptography & P2P Communication
 */

// --- 1. MOTEUR CRYPTOGRAPHIQUE (WEB CRYPTO API) ---

class URYACrypto {
    constructor() {
        this.key = null;
        this.salt = new TextEncoder().encode("URYA_SALT_2026"); // Sel statique pour MyEsther
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
        console.log("✅ [CRYPTO] Clé AES-256 dérivée avec succès.");
    }

    async encrypt(text) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encodedText = new TextEncoder().encode(text);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            this.key,
            encodedText
        );

        // On concatène IV + Ciphertext pour le transport
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv);
        combined.set(new Uint8Array(ciphertext), iv.length);
        
        // Retourne un tableau d'octets compatible avec Socket/WebRTC
        return Array.from(combined);
    }

    async decrypt(combinedArray) {
        try {
            const combined = new Uint8Array(combinedArray);
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);

            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                this.key,
                ciphertext
            );

            return new TextDecoder().decode(decryptedBuffer);
        } catch (e) {
            console.error("❌ Échec du déchiffrement. Clé incorrecte ?");
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

        // Gestion des candidats ICE
        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('webrtc_signal', { type: 'candidate', candidate: event.candidate });
            }
        };

        // Réception du DataChannel (côté passif)
        this.pc.ondatachannel = (event) => {
            this.setupDataChannel(event.channel);
        };

        // Création du DataChannel (côté actif - appelé par Alice)
        this.dataChannel = this.pc.createDataChannel("chat");
        this.setupDataChannel(this.dataChannel);
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;
        channel.onopen = () => {
            console.log("🚀 [WebRTC] Canal P2P Ouvert !");
            this.onStatus("p2p-ready");
        };
        channel.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.onMessage(data);
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
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.socket.emit('webrtc_signal', { type: 'offer', offer: offer });
    }

    send(data) {
        if (this.dataChannel && this.dataChannel.readyState === 'open') {
            try {
                this.dataChannel.send(JSON.stringify(data));
                return true;
            } catch(e) { 
                console.error("DataChannel send error", e);
                return false; 
            }
        }
        return false;
    }

    async hashSecret(secret) {
        const msgUint8 = new TextEncoder().encode(secret);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
}

// --- 2. GESTION DU STOCKAGE PERSISTANT (IndexedDB) ---

class URYAStorage {
    constructor(dbName) {
        this.dbName = `myesther_db_${dbName}`; // Isolation par secret (Déni Plausible)
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = e => reject(e);
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
        const tx = this.db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        store.add({ ...msg, timestamp: Date.now() });
    }

    async loadMessages() {
        if (!this.db) return [];
        return new Promise((resolve) => {
            const tx = this.db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
        });
    }

    static async nuke() {
        // Purge de TOUTES les bases MyEsther trouvées
        const dbs = await window.indexedDB.databases();
        dbs.forEach(db => {
            if (db.name.startsWith('myesther_db_')) {
                window.indexedDB.deleteDatabase(db.name);
            }
        });
        localStorage.clear();
        location.reload();
    }
}

// --- 3. LOGIQUE GLOBALE DE L'APPLICATION ---

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
let currentPrimary = "#7c3aed";
let currentLight = "#a78bfa";
let sessionTimer = null;

async function establishSecureTunnel() {
    const btn = document.getElementById('btn-establish');
    const resetBtn = () => {
        if (btn) {
            btn.innerHTML = window.isEnglish ? "Establish Secure Tunnel" : "Établir le Tunnel Sécurisé";
            btn.disabled = false;
        }
    };

    try {
        const secretEl = document.getElementById('secret-input');
        const aliasEl = document.getElementById('alias-input');
        const groupNameEl = document.getElementById('group-name-input');
        const groupTtlEl = document.getElementById('group-ttl-input');

        currentSecret = secretEl ? secretEl.value : "";
        currentAlias = (aliasEl ? aliasEl.value.trim() : "") || "Anonyme";
        currentGroupName = (groupNameEl ? groupNameEl.value.trim() : "") || "MyEsther Group";
        currentTTL = groupTtlEl ? parseInt(groupTtlEl.value) : 0;
        
        if (!currentSecret || currentSecret.length < 4) {
            alert("🔒 Sécurité : Veuillez entrer un secret plus long.");
            resetBtn();
            return;
        }

        // A. Dérivation de clé Haute Sécurité
        console.log("🛠️ [CRYPTO] Dérivation en cours...");
        await cryptoEngine.deriveKey(currentSecret);
        
        // B. Initialisation du stockage isolé
        const dbId = await cryptoEngine.hashSecret(currentSecret);
        storageEngine = new URYAStorage(dbId);
        await storageEngine.init();

        // C. Connexion Socket IO
        console.log("🌐 [NET] Connexion au serveur...");
        // On permet polling si websocket échoue (plus robuste)
        socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: 3 });

        // Timeout de sécurité (si pas de connect en 10s)
        const connTimeout = setTimeout(() => {
            if (!socket.connected) {
                alert("⌛ Délai de connexion dépassé. Vérifiez votre réseau.");
                resetBtn();
                socket.disconnect();
            }
        }, 10000);

        socket.on('connect', async () => {
            clearTimeout(connTimeout);
            console.log("✅ [NET] Connecté !");
            
            // Calcul de l'expiration locale si TTL > 0
            if (currentTTL > 0) {
                expiryDate = Date.now() + (currentTTL * 1000);
                startSessionTimer();
            }

            if (document.getElementById('active-group-name')) {
                document.getElementById('active-group-name').textContent = currentGroupName;
            }

            socket.emit('join_secure_channel', { shared_secret: currentSecret });
            
            peerController = new URYAPeer(receivePayload, updateP2PStatus);
            peerController.init(socket);
            
            const history = await storageEngine.loadMessages();
            const canvas = document.getElementById('chat-canvas');
            let typing = document.getElementById('typing-indicator');
            if (canvas) {
                canvas.innerHTML = '';
                if (!typing) {
                    typing = document.createElement('div');
                    typing.id = 'typing-indicator';
                    typing.className = "text-[10px] font-black text-brand uppercase tracking-widest opacity-0 transition-opacity duration-300 mb-2";
                    typing.textContent = "Contact est en train d'écrire...";
                }
                canvas.appendChild(typing);
            }

            for (const m of history) {
                const dec = await cryptoEngine.decrypt(m.content);
                if (dec) appendMessage(dec, m.sender_name === 'me' ? 'sent' : 'received', false, m.timestamp, m.burn, m.sender_name);
            }

            peerController.startP2P();

            // Handshake
            setTimeout(async () => {
                const handshake = await cryptoEngine.encrypt(JSON.stringify({
                    groupName: currentGroupName,
                    ttl: currentTTL,
                    expiry: expiryDate
                }));
                socket.emit('encrypted_payload', { type: 'handshake', content: handshake });
            }, 1000);

            document.dispatchEvent(new Event('myesther:connected'));
            saveToHistory(currentSecret);
        });

        socket.on('connect_error', (err) => {
            console.error("❌ Erreur Socket:", err);
            alert("Erreur de connexion au serveur.");
            resetBtn();
        });

        socket.on('webrtc_signal', (data) => peerController.handleSignal(data));
        socket.on('encrypted_payload', (data) => (data.type === 'handshake' ? handleHandshake(data.content) : receivePayload(data)));
        socket.on('room_update', (data) => {
            const counter = document.getElementById('member-counter');
            if (counter) {
                const label = (window.isEnglish ? "members" : "membres");
                counter.textContent = `${data.member_count} ${label}`;
            }
        });

    } catch (error) {
        console.error("💥 CRASH au démarrage:", error);
        alert("Une erreur critique est survenue. Veuillez rafraîchir.");
        resetBtn();
    }
}

function leaveSecureTunnel() {
    // 1. Fermer WebRTC P2P
    if (peerController && peerController.pc) {
        peerController.pc.close();
    }
    peerController = null;

    // 2. Déconnecter du Socket
    if (socket) {
        socket.disconnect();
        socket = null;
    }

    // 3. Purger les timers
    clearInterval(sessionTimer);
    sessionTimer = null;
    clearTimeout(ghostTimer);

    // 4. Nettoyage UI
    currentSecret = "";
    document.getElementById('secret-input').value = "";
    document.getElementById('group-name-input').value = "";
    document.getElementById('expiry-timer').classList.add('hidden');
    
    // Switch Screen
    document.getElementById('chat-screen').classList.remove('visible');
    document.getElementById('setup-screen').style.display = 'flex';

    const btn = document.getElementById('btn-establish');
    if (btn) {
        btn.innerHTML = `<span>Etablir le Tunnel Sécurisé</span>`;
        if (window.applyLanguage) window.applyLanguage();
        btn.disabled = false;
    }

    // 5. Vider le canvas
    const canvas = document.getElementById('chat-canvas');
    if (canvas) canvas.innerHTML = ''; 
}

function updateP2PStatus(status) {
    const badge = document.querySelector('.conn-badge');
    if(status === 'p2p-ready') {
        badge.innerHTML = "⚡ Connexion P2P Directe Établie";
        badge.classList.add('bg-green-100', 'text-green-600');
    }
}

async function sendSecureMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    // Chiffrement AES-GCM réel
    const encryptedData = await cryptoEngine.encrypt(text);
    
    const payload = { 
        type: 'msg', 
        content: encryptedData, 
        sender: currentAlias,
        ttl: currentSendMode === 'burn' ? 10 : (24 * 3600), // 10s ou 24H
        burn: currentSendMode === 'burn'
    };

    // Tenter P2P, sinon fallback Socket
    const sentP2P = peerController.send(payload);
    if (!sentP2P) {
        socket.emit('encrypted_payload', payload);
    }

    // Sauvegarde locale
    if (storageEngine) {
        storageEngine.saveMessage({ ...payload, sender_name: 'me' });
    }

    appendMessage(text, 'sent', false, Date.now(), currentSendMode === 'burn', 'me');
    input.value = '';
    
    // Reset mode après envoi burn
    if (currentSendMode === 'burn') setSendMode('normal');
}

async function receivePayload(payload) {
    if (payload.type === 'msg' || payload.type === 'img') {
        const decryptedContent = await cryptoEngine.decrypt(payload.content);
        if (decryptedContent) {
            // Sauvegarde locale
            if (storageEngine) {
                storageEngine.saveMessage({ ...payload, sender_name: payload.sender || 'them' });
            }

            appendMessage(decryptedContent, 'received', payload.type === 'img', Date.now(), payload.burn, payload.sender || 'them');
            if (window.pushNotification) window.pushNotification();
        }
    } else if (payload.type === 'typing') {
        showTypingIndicator(payload.name);
    }
}

// --- 4. UX & PERSISTENCE ---

function saveToHistory(secret) {
    let history = JSON.parse(localStorage.getItem('myesther_history') || '[]');
    if (!history.includes(secret)) {
        history.push(secret);
        if (history.length > 5) history.shift();
        localStorage.setItem('myesther_history', JSON.stringify(history));
    }
}

function loadHistory() {
    const history = JSON.parse(localStorage.getItem('myesther_history') || '[]');
    const container = document.getElementById('history-tags');
    if (!container) return;
    
    container.innerHTML = history.reverse().map(s => 
        `<button onclick="document.getElementById('secret-input').value='${s}'; establishSecureTunnel()" class="bg-zinc-100 text-zinc-500 text-[10px] px-2 py-1 rounded-full hover:bg-brand hover:text-white transition-colors border border-purple-50">${s.substring(0,8)}...</button>`
    ).join(' ');
}

// --- 5. IMAGES & AUTO-DESTRUCT ---

async function handleImageSelection(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const img = new Image();
        img.onload = async () => {
            // Redimensionnement pour fluidité P2P
            const canvas = document.createElement('canvas');
            const max = 600;
            let w = img.width, h = img.height;
            if (w > max) { h *= max/w; w = max; }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            
            const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
            const encryptedData = await cryptoEngine.encrypt(dataUrl);
            const payload = { type: 'img', content: encryptedData };

            const sentP2P = peerController.send(payload);
            if (!sentP2P && socket) {
                socket.emit('encrypted_payload', encryptedData);
            }
            appendMessage(dataUrl, 'sent', true);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    input.value = ""; // Reset
}

let isAutoDestruct = false;
function toggleAutoDestruct() {
    isAutoDestruct = !isAutoDestruct;
    const btn = document.getElementById('shredder-btn');
    if (isAutoDestruct) {
        btn.classList.remove('text-gray-400');
        btn.classList.add('text-orange-500');
        btn.title = "Mode Éphémère ACTIVÉ (10s)";
        btn.innerHTML = `<svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" /><path stroke-linecap="round" stroke-linejoin="round" d="M12 18a3.75 3.75 0 00.495-7.467 5.99 5.99 0 00-1.925 3.546 5.974 5.974 0 01-2.133-1A3.75 3.75 0 0012 18z" /></svg>`;
    } else {
        btn.classList.remove('text-orange-500');
        btn.classList.add('text-gray-400');
        btn.title = "Mode Éphémère DÉSACTIVÉ";
        btn.innerHTML = `<svg id="icon-clock" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>`;
    }
}

// --- 6. UI UPDATE (MESSAGES) ---

function appendMessage(content, type, isImage = false, timestamp = Date.now(), burnOnRead = false, senderName = '') {
    const canvas = document.getElementById('chat-canvas');
    const time = new Date(timestamp).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    const node = document.createElement('div');
    const msgId = 'msg-' + Math.random().toString(36).substr(2, 9);
    node.id = msgId;

    let body = isImage 
        ? `<img src="${content}" class="max-w-full rounded-xl shadow-sm cursor-zoom-in" onclick="window.open(this.src)"/>`
        : `<p class="text-sm font-bold leading-relaxed ${type==='sent' ? 'text-white' : 'text-gray-800'}">${content}</p>`;

    if (burnOnRead && type === 'received') {
        // Mode Burn-on-Read UI
        body = `
            <div id="cover-${msgId}" class="flex flex-col items-center justify-center p-4 bg-gray-200/50 backdrop-blur-md rounded-xl cursor-pointer hover:bg-gray-300/50 transition-all" onclick="revealBurnMessage('${msgId}')">
                <svg fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-6 h-6 text-gray-400 mb-1"><path stroke-linecap="round" stroke-linejoin="round" d="M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.048 8.287 8.287 0 009 9.6a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z" /></svg>
                <span class="text-[10px] font-black uppercase text-gray-500">Contenu Sensible - Révéler</span>
            </div>
            <div id="content-${msgId}" class="hidden relative">
                ${body}
                <div id="progress-${msgId}" class="burn-progress" style="width: 100%"></div>
            </div>
        `;
    }

    if (type === 'sent') {
        node.className = 'flex flex-col items-end self-end max-w-[82%] space-y-1 mb-4';
        node.innerHTML = `
            <div class="bubble-sent px-4 py-3" style="background:linear-gradient(135deg,${currentPrimary},${currentLight})">
               ${body}
            </div>
            <span class="text-[10px] text-gray-300 font-bold mr-1">${time} ${burnOnRead ? '🔥' : ''}</span>`;
    } else {
        node.className = 'flex flex-col items-start max-w-[82%] space-y-1 mb-4';
        const senderLabel = senderName && senderName !== 'them' ? `<span class="text-[9px] font-black text-brand uppercase ml-2 mb-0.5 block">${senderName}</span>` : '';
        node.innerHTML = `
            ${senderLabel}
            <div class="bubble-recv px-4 py-3">
               ${body}
            </div>
            <span class="text-[10px] text-gray-300 font-bold ml-1">${time}</span>`;
    }

    canvas.appendChild(node);
    canvas.scrollTop = canvas.scrollHeight;

    // Suppression Auto si mode éphémère général actif (et pas burn-on-read déjà)
    if (isAutoDestruct && !burnOnRead) {
        setTimeout(() => node.remove(), 10000);
    }
}

function revealBurnMessage(id) {
    const cover = document.getElementById(`cover-${id}`);
    const content = document.getElementById(`content-${id}`);
    const bar = document.getElementById(`progress-${id}`);
    
    if (cover && content) {
        cover.classList.add('hidden');
        content.classList.remove('hidden');
        
        // Démarrer Chrono visuel
        if (bar) {
            setTimeout(() => bar.style.width = '0%', 100);
        }
        
        // Destruction
        setTimeout(() => {
            const node = document.getElementById(id);
            if (node) {
                node.style.transition = 'all 0.5s';
                node.style.opacity = '0';
                node.style.transform = 'scale(0.8)';
                setTimeout(() => node.remove(), 500);
            }
        }, 10000);
    }
}

// --- 7. TYPING INDICATOR ---

let typingTimeout = null;
function notifyTyping() {
    if (peerController) {
        peerController.send({ type: 'typing', name: 'Contact' });
    }
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

// --- 8. V3 EXCLUSIVES: PANIC, GHOST, HOLD, GROUP SYNC ---

async function handleHandshake(encryptedContent) {
    const raw = await cryptoEngine.decrypt(encryptedContent);
    if (!raw) return;
    const data = JSON.parse(raw);
    
    // Sync Group Name
    if (data.groupName) {
        currentGroupName = data.groupName;
        document.getElementById('active-group-name').textContent = currentGroupName;
    }
    
    // Sync TTL/Expiry
    if (data.ttl > 0 && !sessionTimer) {
        currentTTL = data.ttl;
        expiryDate = data.expiry;
        startSessionTimer();
    }
}

function startSessionTimer() {
    const display = document.getElementById('expiry-timer');
    display.classList.remove('hidden');
    
    sessionTimer = setInterval(() => {
        const remaining = Math.floor((expiryDate - Date.now()) / 1000);
        if (remaining <= 0) {
            clearInterval(sessionTimer);
            alert("⏰ Le temps est écoulé. Session expirée.");
            leaveSecureTunnel();
            return;
        }
        
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        display.textContent = `Exp: ${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);
}

function toggleAdvanced() {
    const panel = document.getElementById('advanced-config');
    const chevron = document.getElementById('adv-chevron');
    panel.classList.toggle('hidden');
    chevron.classList.toggle('rotate-90');
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
    canvas.classList.remove('ghost-mode');
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => {
        canvas.classList.add('ghost-mode');
    }, 10000); // 10 secondes d'inactivité
}

function handleSendStart() {
    holdTimer = setTimeout(() => {
        document.getElementById('hold-menu').classList.add('active');
    }, 600);
}

function handleSendEnd() {
    clearTimeout(holdTimer);
}

function setSendMode(mode) {
    currentSendMode = mode;
    const btn = document.getElementById('send-btn');
    if (mode === 'burn') {
        btn.classList.add('ring-4', 'ring-red-500/30');
    } else {
        btn.classList.remove('ring-4', 'ring-red-500/30');
    }
    document.getElementById('hold-menu').classList.remove('active');
}

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
    loadHistory();
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('input', notifyTyping);
        chatInput.addEventListener('keypress', resetGhostTimer);
    }
    document.addEventListener('mousemove', resetGhostTimer);
    document.addEventListener('touchstart', resetGhostTimer);
    resetGhostTimer();
});

