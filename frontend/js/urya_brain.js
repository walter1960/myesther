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
            this.dataChannel.send(JSON.stringify(data));
            return true;
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
    if (payload.type === 'msg') {
        const decryptedText = await cryptoEngine.decrypt(payload.content);
        if (decryptedText) {
            appendMessage(decryptedText, 'received');
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
        `<button onclick="document.getElementById('secret-input').value='${s}'; establishSecureTunnel()" class="bg-zinc-100 text-zinc-500 text-[10px] px-2 py-1 rounded hover:bg-brand hover:text-white transition-colors">${s.substring(0,6)}...</button>`
    ).join(' ');
}

// Indicateur de frappe
let typingTimeout = null;
function notifyTyping() {
    if (peerController) {
        peerController.send({ type: 'typing', name: 'Contact' });
    }
}

function showTypingIndicator(name) {
    const bar = document.getElementById('typing-indicator');
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
