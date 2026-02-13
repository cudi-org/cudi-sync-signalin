const WebSocket = require('ws');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const PORT = process.env.PORT || 10000;
const wss = new WebSocket.Server({ port: PORT });

const appClients = new Map();
const syncRooms = new Map();
const connectionsPerIP = new Map();

const MAX_MESSAGE_SIZE = 64 * 1024; 
const HEARTBEAT_INTERVAL = 30000;
const TOKEN_TTL = 15 * 60 * 1000;

console.log(`[CUDI-SERVER] Servidor Híbrido iniciado en puerto ${PORT}`);

wss.on('connection', (ws, req) => {
    // Seguridad: Detectar IP tras el proxy de Render
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const currentIPCount = (connectionsPerIP.get(ip) || 0) + 1;
    
    console.log(`[RENDER-NET] Conexión entrante | IP: ${ip} | Activas: ${currentIPCount}`);
    
    if (currentIPCount > 15) {
        console.warn(`[SECURITY] Bloqueando IP ${ip} por exceso de conexiones.`);
        ws.terminate();
        return;
    }
    connectionsPerIP.set(ip, currentIPCount);

    // Inicialización del Cliente
    ws.isAlive = true;
    ws.id = crypto.randomBytes(8).toString('hex');
    ws.isPending = false;
    ws.isAccepted = false;
    ws.msgCount = 0;
    ws.msgTs = Date.now();

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async message => {
        // Rate Limiting
        const now = Date.now();
        if (now - ws.msgTs > 1000) { ws.msgTs = now; ws.msgCount = 0; }
        if (++ws.msgCount > 50) return ws.close(1011);

        const messageString = message.toString();
        if (messageString.length > MAX_MESSAGE_SIZE) return ws.close(1009);

        let data;
        try { 
            data = JSON.parse(messageString); 
        } catch (e) { return; }

        // Enrutamiento por tipo de aplicación
        if (data.appType === 'cudi-sync') {
            await handleSyncLogic(ws, data, messageString);
        } else if (data.appType === 'cudi-messenger') {
            handleMessengerLogic(ws, data, messageString);
        }
    });

    ws.on('close', () => {
        const count = connectionsPerIP.get(ip) - 1;
        if (count <= 0) connectionsPerIP.delete(ip);
        else connectionsPerIP.set(ip, count);
        console.log(`[RENDER-NET] Cliente ${ws.id} desconectado.`);
        limpiarRecursos(ws);
    });
});

async function handleSyncLogic(ws, data, messageString) {
    switch (data.type) {
        case 'join':
            if (!data.room) return;
            console.log(`[SYNC] Intento de unión: Sala ${data.room} por ${ws.id}`);

            if (!syncRooms.has(data.room)) {
                let passwordHash = null;
                if (data.password) passwordHash = await bcrypt.hash(data.password, 10);

                syncRooms.set(data.room, {
                    clients: new Set(),
                    host: ws,
                    password: passwordHash,
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

            // Validación por Token o Password
            const isTokenValid = data.token && (data.token === room.token) && (Date.now() - room.createdAt < TOKEN_TTL);
            if (isTokenValid) {
                room.token = null;
                finalizarUnion(ws, room);
                return;
            }

            if (room.password) {
                if (!data.password) return ws.send(JSON.stringify({ type: 'error', message: 'Password required' }));
                const match = await bcrypt.compare(data.password, room.password);
                if (!match) return ws.send(JSON.stringify({ type: 'error', message: 'Wrong password' }));
            }

            if (room.manualApproval) {
                ws.isPending = true;
                ws.room = data.room;
                room.clients.add(ws);
                room.host.send(JSON.stringify({ type: 'approval_request', peerId: ws.id, alias: data.alias || 'Guest' }));
            } else {
                finalizarUnion(ws, room);
            }
            break;

        case 'signal':
            if (!ws.room || ws.isPending || !syncRooms.has(ws.room)) return;
            
            // --- LÓGICA HÍBRIDA (CONTROL vs DATOS) ---
            const tunnel = data.tunnelType || 'control';
            
            if (data.sdp) {
                console.log(`[SIGNAL] SDP ${data.sdp.type.toUpperCase()} | Túnel: ${tunnel.toUpperCase()} | Sala: ${ws.room}`);
            }

            if (data.candidate) {
                const isTCP = data.candidate.candidate.includes('TCP');
                if (tunnel === 'data' && isTCP) {
                    console.log(`[DIAG-TCP] Candidato TCP recibido para el Túnel de Datos.`);
                }
            }

            const rData = syncRooms.get(ws.room);
            rData.clients.forEach(client => {
                if (client !== ws && !client.isPending && client.readyState === WebSocket.OPEN) {
                    client.send(messageString);
                }
            });
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
            room.clients.forEach(c => { if (c !== ws) c.send(JSON.stringify({ type: 'room_closed' })); });
            syncRooms.delete(ws.room);
        } else {
            room.clients.delete(ws);
        }
    }
    if (ws.peerId && appClients.has('cudi-messenger')) {
        appClients.get('cudi-messenger').delete(ws.peerId);
    }
}

// Heartbeat & Cleanup
const interval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(interval));
