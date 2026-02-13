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
        const now = Date.now();
        if (now - ws.msgTs > 1000) { ws.msgTs = now; ws.msgCount = 0; }
        if (++ws.msgCount > 50) return ws.close(1011);

        const messageString = message.toString();
        if (messageString.length > MAX_MESSAGE_SIZE) return ws.close(1009);

        let data;
        try { 
            data = JSON.parse(messageString); 
        } catch (e) { return; }

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
                return ws.send(JSON.stringify({ type: 'error',
