import os
import hashlib
import time

try:
    import gevent.monkey
    gevent.monkey.patch_all()
    async_mode = 'gevent'
except Exception:
    try:
        import eventlet
        eventlet.monkey_patch()
        async_mode = 'eventlet'
    except Exception:
        async_mode = 'threading'

try:
    import redis
except ImportError:
    redis = None

from flask import Flask, request, send_from_directory, jsonify
from flask_socketio import SocketIO, join_room, emit, leave_room

# Configuration Redis pour la scalabilité (Render/Upstash)
REDIS_URL = os.environ.get('REDIS_URL', '')
redis_client = None

if redis and REDIS_URL:
    try:
        redis_client = redis.from_url(REDIS_URL)
        print(" Connected to Redis cluster")
    except Exception as e:
        print(f" AVERTISSEMENT: Impossible de se connecter à Redis ({e}). Mode mémoire locale activé.")
        redis_client = None

# Dossier frontend
base_dir = os.path.dirname(os.path.abspath(__file__))
frontend_dir = os.path.join(base_dir, 'frontend')
if not os.path.exists(frontend_dir):
    frontend_dir = os.path.join(os.path.dirname(base_dir), 'frontend')

app = Flask(__name__, static_folder=frontend_dir, static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 5 * 1024 * 1024  # 5MB max request

# Configuration SocketIO avec Message Queue Redis
socketio_kwargs = {
    'cors_allowed_origins': "*",
    'async_mode': 'eventlet',
    'max_http_buffer_size': 4 * 1024 * 1024  # 4MB max for audio / voice payloads
}
if redis_client:
    socketio_kwargs['message_queue'] = REDIS_URL

socketio = SocketIO(app, **socketio_kwargs)

# --- Gestion In-Memory de Secours Ultra-Robuste (Si pas de Redis) ---
memory_rooms = {}      # room_id -> {"host": sid, "members": set(), "waiting": {sid: alias}, "with_lobby": bool}
memory_user_room = {}  # sid -> room_id
memory_rate_limit = {} # sid -> [timestamps]

@app.route('/')
def index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/health')
def health():
    return jsonify({"status": "ok", "service": "MyEsther Blind Relay", "timestamp": time.time()})

@app.route('/js/<path:path>')
def send_js(path):
    return send_from_directory(os.path.join(app.static_folder, 'js'), path)

@app.route('/img/<path:path>')
def send_img(path):
    return send_from_directory(os.path.join(app.static_folder, 'img'), path)

@app.route('/manifest.json')
def send_manifest():
    return send_from_directory(app.static_folder, 'manifest.json')

@app.route('/sw.js')
def send_sw():
    return send_from_directory(app.static_folder, 'sw.js')

# --- Utilitaires de Salles & Membres ---
def get_room_member_count(room_id):
    if redis_client:
        try:
            return redis_client.scard(f"room:{room_id}")
        except Exception:
            pass
    if room_id in memory_rooms:
        return len(memory_rooms[room_id]["members"])
    return 0

def add_user_to_room(room_id, sid, alias="Anonyme", enable_lobby=False):
    if redis_client:
        try:
            redis_client.sadd(f"room:{room_id}", sid)
            redis_client.expire(f"room:{room_id}", 86400)
            redis_client.set(f"user:{sid}", room_id, ex=86400)
        except Exception:
            pass
    
    if room_id not in memory_rooms:
        memory_rooms[room_id] = {
            "host": sid,
            "members": {sid},
            "waiting": {},
            "with_lobby": enable_lobby
        }
    else:
        memory_rooms[room_id]["members"].add(sid)
    memory_user_room[sid] = room_id

def remove_user_from_room(sid):
    room_id = None
    if redis_client:
        try:
            r = redis_client.get(f"user:{sid}")
            if r:
                room_id = r.decode('utf-8')
                redis_client.srem(f"room:{room_id}", sid)
                redis_client.delete(f"user:{sid}")
        except Exception:
            pass
            
    if not room_id and sid in memory_user_room:
        room_id = memory_user_room.pop(sid, None)

    if room_id and room_id in memory_rooms:
        memory_rooms[room_id]["members"].discard(sid)
        memory_rooms[room_id]["waiting"].pop(sid, None)
        if len(memory_rooms[room_id]["members"]) == 0 and len(memory_rooms[room_id]["waiting"]) == 0:
            memory_rooms.pop(room_id, None)
        elif memory_rooms[room_id].get("host") == sid:
            # Réassigner l'hôte au prochain membre
            if memory_rooms[room_id]["members"]:
                memory_rooms[room_id]["host"] = next(iter(memory_rooms[room_id]["members"]))

    return room_id

def check_rate_limit(sid):
    now = time.time()
    if redis_client:
        try:
            key = f"rate:{sid}"
            count = redis_client.incr(key)
            if count == 1:
                redis_client.expire(key, 1)
            return count <= 25  # 25 messages max/sec
        except Exception:
            pass
            
    # Fallback Mémoire
    timestamps = memory_rate_limit.get(sid, [])
    timestamps = [t for t in timestamps if now - t < 1.0]
    if len(timestamps) > 25:
        return False
    timestamps.append(now)
    memory_rate_limit[sid] = timestamps
    return True

@socketio.on('connect')
def test_connect():
    print(f" [Connexion Client] SID: {request.sid}")

@socketio.on('disconnect')
def handle_disconnect():
    room = remove_user_from_room(request.sid)
    memory_rate_limit.pop(request.sid, None)
    if room:
        print(f" [Déconnexion] Client {request.sid} a quitté le salon {room}.")
        count = get_room_member_count(room)
        emit('room_update', {'member_count': count}, room=room)
        emit('system_message', {'type': 'disconnect', 'status': 'Contact offline'}, room=room)

@socketio.on('join_secure_channel')
def handle_join(data):
    raw_password = data.get('shared_secret', '')
    alias = data.get('alias', 'Anonyme')
    enable_lobby = data.get('enable_lobby', False)
    
    if not raw_password:
        emit('system_message', {'type': 'error', 'status': 'Clé secrète requise.'})
        return
        
    # ROUTAGE DU CANAL DÉRIVÉ : Hachage SHA-256
    room_id = hashlib.sha256(raw_password.encode('utf-8')).hexdigest()[:12]
    
    # Vérification de la Salle d'Attente (Lobby)
    is_first_user = (room_id not in memory_rooms) or (len(memory_rooms[room_id]["members"]) == 0)
    
    if not is_first_user and memory_rooms.get(room_id, {}).get("with_lobby", False):
        # L'invité est placé en salle d'attente
        memory_rooms[room_id]["waiting"][request.sid] = alias
        memory_user_room[request.sid] = room_id
        host_sid = memory_rooms[room_id]["host"]
        print(f" [Lobby] {alias} ({request.sid}) frappe à la porte de {room_id}")
        
        # Notifier l'hôte
        emit('knock_request', {
            'guest_sid': request.sid,
            'guest_alias': alias
        }, room=host_sid)
        
        # Informer l'invité qu'il attend
        emit('knock_waiting', {'status': "En attente de l'approbation de l'hôte..."})
        return

    # Entrée directe
    members = get_room_member_count(room_id)
    if members >= 20:
        emit('system_message', {'type': 'error', 'status': 'Tunnel complet (max 20)'})
        return

    join_room(room_id)
    add_user_to_room(room_id, request.sid, alias=alias, enable_lobby=enable_lobby)
    
    print(f" [Canal Établi] {alias} ({request.sid}) rejoint: {room_id} ({members+1} membres)")
    
    count = get_room_member_count(room_id)
    emit('room_update', {'member_count': count}, room=room_id)
    emit('system_message', {'type': 'success', 'status': 'Connected to Secure Tunnel', 'is_host': is_first_user}, room=request.sid)

@socketio.on('approve_knock')
def handle_approve_knock(data):
    guest_sid = data.get('guest_sid')
    room_id = memory_user_room.get(request.sid)
    
    if not room_id or room_id not in memory_rooms:
        return
        
    room_info = memory_rooms[room_id]
    if room_info["host"] != request.sid:
        return # Seul l'hôte peut approuver
        
    if guest_sid in room_info.get("waiting", {}):
        guest_alias = room_info["waiting"].pop(guest_sid, "Anonyme")
        room_info["members"].add(guest_sid)
        
        # Faire rejoindre la room SocketIO au client approuvé
        socketio.server.enter_room(guest_sid, room_id)
        
        print(f" [Lobby Approuvé] {guest_alias} ({guest_sid}) accepté dans {room_id}")
        emit('knock_approved', {'status': 'Approved', 'room_id': room_id}, room=guest_sid)
        
        count = get_room_member_count(room_id)
        emit('room_update', {'member_count': count}, room=room_id)
        emit('system_message', {'type': 'success', 'status': f'{guest_alias} a rejoint le salon.'}, room=room_id)

@socketio.on('reject_knock')
def handle_reject_knock(data):
    guest_sid = data.get('guest_sid')
    room_id = memory_user_room.get(request.sid)
    
    if room_id and room_id in memory_rooms:
        room_info = memory_rooms[room_id]
        if room_info["host"] == request.sid and guest_sid in room_info.get("waiting", {}):
            room_info["waiting"].pop(guest_sid, None)
            memory_user_room.pop(guest_sid, None)
            print(f" [Lobby Rejeté] {guest_sid} refusé pour {room_id}")
            emit('knock_rejected', {'status': "L'hôte a refusé votre demande d'accès."}, room=guest_sid)

@socketio.on('encrypted_payload')
def handle_encrypted_message(payload_data):
    if not check_rate_limit(request.sid):
        return
        
    room_id = memory_user_room.get(request.sid)
    if not room_id and redis_client:
        try:
            r = redis_client.get(f"user:{request.sid}")
            if r: room_id = r.decode('utf-8')
        except Exception:
            pass

    if room_id:
        emit('encrypted_payload', payload_data, room=room_id, include_self=False)

@socketio.on('webrtc_signal')
def handle_webrtc_signal(data):
    if not check_rate_limit(request.sid):
        return

    room_id = memory_user_room.get(request.sid)
    if not room_id and redis_client:
        try:
            r = redis_client.get(f"user:{request.sid}")
            if r: room_id = r.decode('utf-8')
        except Exception:
            pass

    if room_id:
        emit('webrtc_signal', data, room=room_id, include_self=False)

if __name__ == '__main__':
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    
    print("="*60)
    print(" URYA BLIND RELAY SERVER - ZERO-KNOWLEDGE ROUTER")
    print(" Featuring In-Memory Fallback, Lobby Approvals & 4MB Payloads")
    print("="*60)
    
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, host='0.0.0.0', port=port, debug=False)
