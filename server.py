import os
import hashlib
from flask import Flask, request, send_from_directory
from flask_socketio import SocketIO, join_room, emit

# Dossier frontend (compatible local et cloud)
# Render exécute depuis la racine du repo
base_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.join(base_dir, 'frontend')

app = Flask(__name__, static_folder=frontend_dir, static_url_path='')
socketio = SocketIO(app, cors_allowed_origins="*")

active_users = {}

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
        print(f"❌ [Déconnexion] Client {request.sid} a quitté le salon {room}.")
        # Optionnel: Notifier l'autre l'utilisateur que son contact est déconnecté
        if room:
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
    # On prend les 12 premiers caractères hexadécimaux pour le nom du salon
    room_id = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()[:12]
    
    join_room(room_id)
    active_users[request.sid]['room'] = room_id
    
    print(f"🔒 [Canal Établi] Un client a rejoint le salon dérivé: {room_id}")
    
    # Notifier tous ceux dans la salle qu'une nouvelle connexion est active.
    # Ceci n'envoie aucune information sécurisée, juste un ping de présence.
    emit('system_message', {'type': 'success', 'status': 'Connected to Secure Tunnel'}, room=room_id)

@socketio.on('encrypted_payload')
def handle_encrypted_message(payload_data):
    """
    Le Cœur du relai aveugle. 
    Reçoit un tableau d'octets chiffrés et l'envoie à tous (sauf l'expéditeur) dans le même salon.
    """
    room_id = active_users.get(request.sid, {}).get('room')
    
    if room_id:
        # Le serveur ne tente pas de lire le payload_data
        # Il le balance simplement aux autres.
        emit('encrypted_payload', payload_data, room=room_id, include_self=False)
        print(f"📡 [Relai] Transfert d'une trame cryptée ({len(str(payload_data))} bytes) dans le salon {room_id}")

if __name__ == '__main__':
    # Mode silencieux, sans logs superflus
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    
    print("="*60)
    print("🛡️ URYA BLIND RELAY SERVER - ACTIF")
    print("Zero-Knowledge Routing Engine")
    print("="*60)
    
    # Écoute sur le port 5000 par défaut
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)
