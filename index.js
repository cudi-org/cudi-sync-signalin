const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const appClients = new Map();
const syncRooms = new Map();

const MAX_MESSAGE_SIZE = 64 * 1024; 
const HEARTBEAT_INTERVAL = 30000;

function heartbeat() {
    this.isAlive = true;
}

console.log(`[Server] Signaling server started on port ${PORT}`);

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    
    ws.id = crypto.randomBytes(8).toString('hex');
    ws.isPending = false;
    console.log(`[Connection] New client connected. ID: ${ws.id}`);

    ws.on('message', message => {
        if (message.length > MAX_MESSAGE_SIZE) {
            console.warn(`[Security] Message too large from ${ws.id}`);
            return ws.close(1009, 'Message too large');
        }

        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error(`[Error] Failed to parse JSON from ${ws.id}`);
            return;
        }

        const appType = data.appType || 'default';

        if (appType === 'cudi-messenger') {
            handleMessengerLogic(ws, data, message);
        } else if (appType === 'cudi-sync') {
            handleSyncLogic(ws, data, message);
        }
    });

    ws.on('close', () => {
        console.log(`[Connection] Client disconnected: ${ws.id}`);
        limpiarRecursos(ws);
    });
});

function handleSyncLogic(ws, data, message) {
    switch (data.type) {
        case 'join':
            if (!data.room) {
                console.warn(`[cudi-sync] Join attempt without room ID from ${ws.id}`);
                return;
            }

            if (!syncRooms.has(data.room)) {
                syncRooms.set(data.room, {
                    clients: new Set(),
                    host: ws,
                    password: data.password || null,
                    manualApproval: data.manualApproval || false,
                    token: crypto.randomBytes(16).toString('hex')
                });

                ws.room = data.room;
                ws.isHost = true;
                const room = syncRooms.get(data.room);
                room.clients.add(ws);

                ws.send(JSON.stringify({ 
                    type: 'room_created', 
                    token: room.token,
                    room: data.room 
                }));
                console.log(`[cudi-sync] Room created: ${data.room} by ${ws.id}`);
                return;
            }

            const room = syncRooms.get(data.room);
            const viaToken = (data.token === room.token);

            if (!viaToken) {
                if (room.password && data.password !== room.password) {
                    console.warn(`[Security] Invalid password attempt for room: ${data.room}`);
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid password' }));
                    return;
                }

                if (room.manualApproval) {
                    if (room.host && room.host.readyState === WebSocket.OPEN) {
                        ws.isPending = true;
                        ws.room = data.room;
                        room.clients.add(ws);
                        
                        room.host.send(JSON.stringify({ 
                            type: 'approval_request', 
                            peerId: ws.id, 
                            alias: data.alias || 'Anonymous' 
                        }));
                        console.log(`[cudi-sync] Pending approval for ${ws.id} in room ${data.room}`);
                        return;
                    }
                }
            }

            finalizarUnion(ws, room);
            break;

        case 'approve_user':
            if (ws.isHost && ws.room && syncRooms.has(ws.room)) {
                const roomData = syncRooms.get(ws.room);
                const pendingUser = Array.from(roomData.clients).find(c => c.id === data.peerId);
                if (pendingUser) {
                    console.log(`[cudi-sync] Host approved user: ${data.peerId}`);
                    finalizarUnion(pendingUser, roomData);
                }
            }
            break;

        case 'signal':
            if (ws.room && !ws.isPending && syncRooms.has(ws.room)) {
                const roomData = syncRooms.get(ws.room);
                roomData.clients.forEach(client => {
                    if (client !== ws && !client.isPending && client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
            }
            break;
    }
}

function finalizarUnion(ws, room) {
    ws.isPending = false;
    ws.room = ws.room || Array.from(syncRooms.keys()).find(k => syncRooms.get(k) === room);
    room.clients.add(ws);
    
    ws.send(JSON.stringify({ type: 'joined', room: ws.room }));
    console.log(`[cudi-sync] User ${ws.id} joined room: ${ws.room}`);

    if (room.clients.size >= 2) {
        console.log(`[cudi-sync] Initiating negotiation in room: ${ws.room}`);
        room.host.send(JSON.stringify({ type: 'start_negotiation' }));
    }
}

function handleMessengerLogic(ws, data, message) {
    const clients = appClients.get('cudi-messenger') || new Map();
    appClients.set('cudi-messenger', clients);
    
    switch (data.type) {
        case 'register':
            if (data.peerId) {
                clients.set(data.peerId, ws);
                ws.peerId = data.peerId;
                ws.appType = 'cudi-messenger';
                ws.send(JSON.stringify({ type: 'registered', peerId: data.peerId }));
                console.log(`[cudi-messenger] Client registered: ${data.peerId}`);
            }
            break;
        case 'offer':
        case 'answer':
        case 'candidate':
            if (data.targetPeerId && clients.has(data.targetPeerId)) {
                const targetWs = clients.get(data.targetPeerId);
                if (targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(message);
                }
            }
            break;
    }
}

function limpiarRecursos(ws) {
    if (ws.room && syncRooms.has(ws.room)) {
        const room = syncRooms.get(ws.room);
        room.clients.delete(ws);
        console.log(`[Cleanup] Removed ${ws.id} from room ${ws.room}`);
        if (room.clients.size === 0) {
            syncRooms.delete(ws.room);
            console.log(`[Cleanup] Deleted empty room: ${ws.room}`);
        }
    }
    if (ws.peerId && appClients.has('cudi-messenger')) {
        appClients.get('cudi-messenger').delete(ws.peerId);
    }
}

const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            console.log(`[Heartbeat] Terminating inactive connection: ${ws.id}`);
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
    clearInterval(interval);
    console.log('[Server] Heartbeat interval cleared');
});
