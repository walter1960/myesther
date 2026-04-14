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
                iterations: 100000,
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
}

// --- 3. LOGIQUE GLOBALE DE L'APPLICATION ---

const cryptoEngine = new URYACrypto();
let peerController = null;
let socket = null;
let currentSecret = "";

async function establishSecureTunnel() {
    currentSecret = document.getElementById('secret-input').value;
    if (!currentSecret || currentSecret.length < 4) {
        alert("🔒 Sécurité : Veuillez entrer un secret plus long.");
        return;
    }

    // A. Dérivation de clé Haute Sécurité
    await cryptoEngine.deriveKey(currentSecret);

    // B. Connexion Socket IO (Signaling)
    socket = io({ transports: ['websocket'] });

    socket.on('connect', () => {
        socket.emit('join_secure_channel', { shared_secret: currentSecret });
        
        // Initialiser le P2P
        peerController = new URYAPeer(receivePayload, updateP2PStatus);
        peerController.init(socket);
        
        // On tente de démarrer le P2P (Alice envoie l'offre)
        peerController.startP2P();

        // UI Transition
        document.dispatchEvent(new Event('myesther:connected'));
        saveToHistory(currentSecret);
    });

    socket.on('webrtc_signal', (data) => {
        peerController.handleSignal(data);
    });

    socket.on('encrypted_payload', (data) => {
        // Fallback si WebRTC n'est pas encore prêt
        receivePayload({ type: 'msg', content: data });
    });
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

    currentSecret = "";
    document.getElementById('secret-input').value = "";

    // 3. Réinitialiser la zone de message (canvas)
    const canvas = document.getElementById('chat-canvas');
    if (canvas) {
        canvas.innerHTML = `
    <div id="typing-indicator" class="text-[10px] font-black text-brand uppercase tracking-widest opacity-0 transition-opacity duration-300 mb-2">
      Contact est en train d'écrire...
    </div>
    <div class="flex justify-center">
      <span class="text-xs font-black text-gray-400 uppercase tracking-widest bg-gray-100 px-4 py-2 rounded-full conn-badge">
        Tunnel Sécurisé Etabli
      </span>
    </div>
    <div class="flex flex-col items-start max-w-[82%] space-y-1">
      <div class="bubble-recv px-5 py-3">
        <p class="text-sm font-bold leading-relaxed">Bonjour ! Vous êtes connecté(e) en toute sécurité.</p>
      </div>
      <span class="text-[10px] text-gray-300 font-bold ml-1">Maintenant</span>
    </div>
        `;
    }

    // Restaurer le badge P2P d'origine
    const badge = document.querySelector('.conn-badge');
    if (badge) {
        badge.innerHTML = "Tunnel Sécurisé Etabli";
        badge.classList.remove('bg-green-100', 'text-green-600');
    }

    // Remettre le bouton
    const btn = document.getElementById('btn-establish');
    if (btn) {
        btn.innerHTML = `<span id="btn-text">Etablir le Tunnel Sécurisé</span>`;
        btn.disabled = false;
        if (window.applyLanguage) window.applyLanguage();
    }

    // 4. Transitions UI
    document.getElementById('chat-screen').classList.remove('visible');
    document.getElementById('setup-screen').style.display = 'flex';
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
    
    const payload = { type: 'msg', content: encryptedData };

    // Tenter P2P, sinon fallback Socket
    const sentP2P = peerController.send(payload);
    if (!sentP2P) {
        socket.emit('encrypted_payload', encryptedData);
    }

    appendMessage(text, 'sent');
    input.value = '';
}

async function receivePayload(payload) {
    if (payload.type === 'msg' || payload.type === 'img') {
        const decryptedContent = await cryptoEngine.decrypt(payload.content);
        if (decryptedContent) {
            if (payload.type === 'img') {
                appendMessage(decryptedContent, 'received', true);
            } else {
                appendMessage(decryptedContent, 'received');
            }
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

function appendMessage(content, type, isImage = false) {
    const canvas = document.getElementById('chat-canvas');
    const time = new Date().toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    const node = document.createElement('div');
    const msgId = 'msg-' + Math.random().toString(36).substr(2, 9);
    node.id = msgId;

    let body = isImage 
        ? `<img src="${content}" class="max-w-full rounded-xl shadow-sm cursor-zoom-in" onclick="window.open(this.src)"/>`
        : `<p class="text-sm font-bold leading-relaxed ${type==='sent' ? 'text-white' : 'text-gray-800'}">${content}</p>`;

    if (type === 'sent') {
        node.className = 'flex flex-col items-end self-end max-w-[82%] space-y-1 mb-4';
        node.innerHTML = `
            <div class="bubble-sent px-4 py-3" style="background:linear-gradient(135deg,${currentPrimary},${currentLight})">
               ${body}
            </div>
            <span class="text-[10px] text-gray-300 font-bold mr-1">${time}</span>`;
    } else {
        node.className = 'flex flex-col items-start max-w-[82%] space-y-1 mb-4';
        node.innerHTML = `
            <div class="bubble-recv px-4 py-3">
               ${body}
            </div>
            <span class="text-[10px] text-gray-300 font-bold ml-1">${time}</span>`;
    }

    canvas.appendChild(node);
    canvas.scrollTop = canvas.scrollHeight;

    // Auto-Destruction logic
    if (isAutoDestruct) {
        node.style.transition = 'opacity 2s ease, transform 2s ease';
        setTimeout(() => {
            node.style.opacity = '0';
            node.style.transform = 'translateY(-10px) scale(0.95)';
            setTimeout(() => node.remove(), 2000);
        }, 10000); // 10 secondes
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

// Initialisation
document.addEventListener('DOMContentLoaded', () => {
    loadHistory();
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
        chatInput.addEventListener('input', notifyTyping);
    }
});
