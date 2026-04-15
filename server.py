import eventlet
eventlet.monkey_patch()
import os
import hashlib
from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, join_room, emit

import time

# Dossier frontend (compatible local et cloud)
# Render exécute depuis la racine du repo
base_dir = os.path.dirname(os.path.abspath(__file__))
# Pour le local, on regarde un niveau au-dessus si backend/frontend n'existe pas
frontend_dir = os.path.join(os.path.dirname(base_dir), 'frontend')
if not os.path.exists(frontend_dir):
    frontend_dir = os.path.join(base_dir, 'frontend')

app = Flask(__name__, static_folder=frontend_dir, static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Mémoire amnésique du serveur
active_users = {}
rate_limit = {} # {sid: last_message_time}

@app.route('/')
def index():
    """Sert l'interface graphique PWA"""
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/js/<path:path>')
def send_js(path):
    return send_from_directory(os.path.join(app.static_folder, 'js'), path)

@app.route('/manifest.json')
def send_manifest():
    return send_from_directory(app.static_folder, 'manifest.json')

@app.route('/sw.js')
def send_sw():
    return send_from_directory(app.static_folder, 'sw.js')

@socketio.on('connect')
def test_connect():
    """Un utilisateur vient d'ouvrir l'application (pas encore dans un salon)"""
    active_users[request.sid] = {'room': None}
    print(f"🔗 [Nouvelle connexion brute] Client {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    """Un utilisateur ferme l'application (ou perd le réseau)"""
    if request.sid in active_users:
        room = active_users[request.sid]['room']
        del active_users[request.sid]
        print(f" [Déconnexion] Client {request.sid} a quitté le salon {room}.")
        # Notifier tout le monde du nouveau compte
        if room:
            update_room_count(room)
            emit('system_message', {'type': 'disconnect', 'status': 'Contact offline'}, room=room)

@socketio.on('join_secure_channel')
def handle_join(data):
    """
    L'application PWA envoie un mot de passe pour rejoindre un salon.
    Le serveur HACHE ce mot de passe immédiatement pour créer l'ID du salon,
    garantissant qu'il ne conserve jamais le mot de passe d'origine.
    """
    raw_password = data.get('shared_secret', '')
    if not raw_password:
        return
        
    # ROUTAGE DU CANAL DÉRIVÉ : Hachage SHA-256 pour l'ID du Salon
    room_id = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()[:12]
    
    # Vérification de limite (ex: 20 membres)
    members = 0
    for u in active_users.values():
        if u.get('room') == room_id:
            members += 1
    
    if members >= 20:
        emit('system_message', {'type': 'error', 'status': 'Tunnel complet (max 20)'})
        return

    join_room(room_id)
    active_users[request.sid]['room'] = room_id
    
    print(f" [Canal Établi] Client {request.sid} rejoint: {room_id} ({members+1} membres)")
    
    # Mise à jour du compteur pour tout le monde
    update_room_count(room_id)
    emit('system_message', {'type': 'success', 'status': 'Connected to Secure Tunnel'}, room=room_id)

def update_room_count(room_id):
    """Calcule et diffuse le nombre d'utilisateurs actifs dans un salon"""
    count = 0
    for u in active_users.values():
        if u.get('room') == room_id:
            count += 1
    emit('room_update', {'member_count': count}, room=room_id)

@socketio.on('encrypted_payload')
def handle_encrypted_message(payload_data):
    """
    Relai de secours pour les messages chiffrés (si le P2P échoue).
    """
    # Simple Rate Limiting manuel
    now = time.time()
    last_time = rate_limit.get(request.sid, 0)
    if now - last_time < 0.1: # Max 10 messages par seconde
        return
    rate_limit[request.sid] = now

    room_id = active_users.get(request.sid, {}).get('room')
    if room_id:
        emit('encrypted_payload', payload_data, room=room_id, include_self=False)

@socketio.on('webrtc_signal')
def handle_webrtc_signal(data):
    """
    Relai de Signalisation WebRTC (Indispensable pour le P2P).
    Transmet les offres, réponses et candidats ICE entre les pairs.
    """
    room_id = active_users.get(request.sid, {}).get('room')
    if room_id:
        # On renvoie le signal à tout le monde dans le salon (sauf l'expéditeur)
        emit('webrtc_signal', data, room=room_id, include_self=False)
        print(f" [Signaling] Relai de signal WebRTC dans le salon {room_id}")

if __name__ == '__main__':
    # Mode silencieux, sans logs superflus
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    
    print("="*60)
    print(" URYA BLIND RELAY SERVER - ACTIF")
    print("Zero-Knowledge Routing Engine")
    print("="*60)
    
    # Écoute sur le port 5000 par défaut
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)
