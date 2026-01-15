const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });

const appClients = new Map();
const syncRooms = new Map();
const connectionsPerIP = new Map();

const MAX_MESSAGE_SIZE = 64 * 1024; 
const HEARTBEAT_INTERVAL = 30000;
const TOKEN_TTL = 15 * 60 * 1000;

function heartbeat() { this.isAlive = true; }

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const currentIPCount = (connectionsPerIP.get(ip) || 0) + 1;
    
    if (currentIPCount > 15) {
        ws.terminate();
        return;
    }
    connectionsPerIP.set(ip, currentIPCount);

    ws.isAlive = true;
    ws.id = crypto.randomBytes(8).toString('hex');
    ws.isPending = false;
    ws.isAccepted = false;
    ws.msgCount = 0;
    ws.msgTs = Date.now();

    ws.on('pong', heartbeat);

    ws.on('message', message => {
        const now = Date.now();
        if (now - ws.msgTs > 1000) { 
            ws.msgTs = now; 
            ws.msgCount = 0; 
        }
        if (++ws.msgCount > 30) return ws.close(1011);

        const messageString = message.toString();
        if (messageString.length > MAX_MESSAGE_SIZE) return ws.close(1009);

        let data;
        try { 
            data = JSON.parse(messageString); 
        } catch (e) { 
            return; 
        }

        if (data.appType === 'cudi-sync') handleSyncLogic(ws, data, messageString);
        else if (data.appType === 'cudi-messenger') handleMessengerLogic(ws, data, messageString);
    });

    ws.on('close', () => {
        const count = connectionsPerIP.get(ip) - 1;
        if (count <= 0) connectionsPerIP.delete(ip);
        else connectionsPerIP.set(ip, count);
        limpiarRecursos(ws);
    });
});

function handleSyncLogic(ws, data, messageString) {
    switch (data.type) {
        case 'join':
            if (!data.room) return;

            if (!syncRooms.has(data.room)) {
                syncRooms.set(data.room, {
                    clients: new Set(),
                    host: ws,
                    password: data.password || null,
                    manualApproval: data.manualApproval || false,
                    token: crypto.randomBytes(16).toString('hex'),
                    createdAt: Date.now()
                });
                ws.room = data.room;
                ws.isHost = true;
                ws.isAccepted = true;
                syncRooms.get(data.room).clients.add(ws);
                
                ws.send(JSON.stringify({ 
                    type: 'room_created', 
                    token: syncRooms.get(data.room).token,
                    room: data.room 
                }));
                return;
            }

            const room = syncRooms.get(data.room);

            if (room.clients.size >= 2) {
                return ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
            }

            const isTokenValid = data.token && (data.token === room.token) && (Date.now() - room.createdAt < TOKEN_TTL);

            if (isTokenValid) {
                room.token = null;
                finalizarUnion(ws, room);
                return;
            }

            if (room.password && data.password !== room.password) {
                return ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
            }

            if (room.manualApproval) {
                ws.isPending = true;
                ws.room = data.room;
                room.clients.add(ws);
                room.host.send(JSON.stringify({ 
                    type: 'approval_request', 
                    peerId: ws.id, 
                    alias: data.alias || 'Guest' 
                }));
            } else {
                finalizarUnion(ws, room);
            }
            break;

        case 'approval_response':
            if (!ws.isHost || !syncRooms.has(ws.room)) return;
            const targetRoom = syncRooms.get(ws.room);
            const guest = [...targetRoom.clients].find(c => c.id === data.peerId);
            
            if (guest && data.approved) {
                finalizarUnion(guest, targetRoom);
                guest.send(JSON.stringify({ type: 'approved' }));
            } else if (guest) {
                guest.send(JSON.stringify({ type: 'rejected' }));
                targetRoom.clients.delete(guest);
                guest.terminate();
            }
            break;

        case 'signal':
            if (!ws.room || ws.isPending || !syncRooms.has(ws.room)) return;
            const rData = syncRooms.get(ws.room);
            rData.clients.forEach(client => {
                if (client !== ws && !client.isPending && client.readyState === WebSocket.OPEN) {
                    client.send(messageString);
                }
            });
            break;
    }
}

function finalizarUnion(ws, room) {
    ws.isPending = false;
    ws.isAccepted = true;
    ws.room = ws.room || Array.from(syncRooms.keys()).find(k => syncRooms.get(k) === room);
    room.clients.add(ws);
    ws.send(JSON.stringify({ type: 'joined', room: ws.room }));
    if (room.clients.size >= 2) room.host.send(JSON.stringify({ type: 'start_negotiation' }));
}

function handleMessengerLogic(ws, data, messageString) {
    const clients = appClients.get('cudi-messenger') || new Map();
    appClients.set('cudi-messenger', clients);
    
    switch (data.type) {
        case 'register':
            if (data.peerId) {
                clients.set(data.peerId, ws);
                ws.peerId = data.peerId;
                ws.appType = 'cudi-messenger';
                ws.send(JSON.stringify({ type: 'registered', peerId: data.peerId }));
            }
            break;
        case 'offer':
        case 'answer':
        case 'candidate':
            if (data.targetPeerId && clients.has(data.targetPeerId)) {
                const targetWs = clients.get(data.targetPeerId);
                if (targetWs.readyState === WebSocket.OPEN) targetWs.send(messageString);
            }
            break;
    }
}

function limpiarRecursos(ws) {
    if (ws.room && syncRooms.has(ws.room)) {
        const room = syncRooms.get(ws.room);
        if (ws.isHost) {
            room.clients.forEach(c => { 
                if (c !== ws) c.send(JSON.stringify({ type: 'room_closed' })); 
            });
            syncRooms.delete(ws.room);
        } else {
            room.clients.delete(ws);
        }
    }
    if (ws.peerId && appClients.has('cudi-messenger')) {
        appClients.get('cudi-messenger').delete(ws.peerId);
    }
}

const interval = setInterval(() => {
    const now = Date.now();
    syncRooms.forEach((room, roomId) => {
        if (now - room.createdAt > TOKEN_TTL && room.clients.size === 0) {
            syncRooms.delete(roomId);
        }
    });

    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(interval));
