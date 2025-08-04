const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: PORT });
const appClients = new Map();
const syncRooms = new Map();

console.log(`Servidor de señalización multipropósito iniciado en el puerto ${PORT}`);

wss.on('connection', ws => {
    console.log('Cliente conectado');

    ws.id = Math.random().toString(36).substring(2, 15);
    console.log(`Cliente temporal ID: ${ws.id}`);

    ws.on('message', message => {
        let data;
        try {
            data = JSON.parse(message);
        } catch (e) {
            console.error('Error al parsear el mensaje JSON:', e, 'Mensaje:', message);
            return;
        }

        const appType = data.appType || 'default';
        const senderId = data.senderPeerId || ws.peerId || ws.id;

        console.log(`[${appType}] Mensaje recibido: ${data.type} de ${senderId} a ${data.targetPeerId || data.room || 'sin objetivo'}`);

        if (appType === 'cudi-messenger') {
            handleMessengerLogic(ws, data, message);
        } 
        else if (appType === 'cudi-sync') {
            handleSyncLogic(ws, data, message);
        }
        else {
            console.warn(`[${appType}] Tipo de mensaje desconocido: ${data.type}`);
        }
    });

    ws.on('close', () => {
        const closedPeerId = ws.peerId;
        const closedAppType = ws.appType || 'default';

        console.log(`Cliente desconectado: ${closedPeerId || ws.id} (App: ${closedAppType})`);

        if (closedAppType === 'cudi-messenger') {
            const clients = appClients.get(closedAppType);
            if (clients && clients.has(closedPeerId)) {
                clients.delete(closedPeerId);
                console.log(`[${closedAppType}] Cliente ${closedPeerId} removido. Clientes restantes: ${clients.size}`);
                if (clients.size === 0) {
                    appClients.delete(closedAppType);
                }
            }
        } else if (closedAppType === 'cudi-sync') {
            const room = ws.room;
            if (room && syncRooms.has(room)) {
                const roomClients = syncRooms.get(room);
                roomClients.delete(ws);
                console.log(`[${closedAppType}] Cliente removido de sala: ${room}. Clientes restantes: ${roomClients.size}`);

                if (roomClients.size === 0) {
                    syncRooms.delete(room);
                    console.log(`[${closedAppType}] Sala ${room} ahora está vacía y ha sido eliminada.`);
                }
            }
        }
    });

    ws.on('error', error => {
        console.error(`Error del WebSocket para ${ws.peerId || ws.id} (App: ${ws.appType || 'unknown'}):`, error);
    });
});

function handleMessengerLogic(ws, data, message) {
    const clients = appClients.get('cudi-messenger') || new Map();
    appClients.set('cudi-messenger', clients);
    
    switch (data.type) {
        case 'register':
            if (data.peerId) {
                if (clients.has(data.peerId) && clients.get(data.peerId) !== ws) {
                    console.warn(`[cudi-messenger] Peer ID ${data.peerId} ya está en uso. Desconectando cliente antiguo.`);
                    clients.get(data.peerId).close(1008, 'Peer ID en uso');
                }
                clients.set(data.peerId, ws);
                ws.peerId = data.peerId;
                ws.appType = 'cudi-messenger';
                ws.send(JSON.stringify({ type: 'registered', peerId: data.peerId, appType: 'cudi-messenger' }));
                console.log(`[cudi-messenger] Cliente registrado: ${data.peerId}. Clientes activos: ${clients.size}`);
            } else {
                console.warn('[cudi-messenger] Mensaje de registro sin peerId.');
            }
            break;
        case 'offer':
        case 'answer':
        case 'candidate':
        case 'public-key-exchange':
            if (data.targetPeerId && clients.has(data.targetPeerId)) {
                const targetWs = clients.get(data.targetPeerId);
                if (targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(message); 
                    console.log(`[cudi-messenger] Retransmitido ${data.type} de ${data.senderPeerId} a ${data.targetPeerId}`);
                } else {
                    console.warn(`[cudi-messenger] Cliente objetivo ${data.targetPeerId} no está listo para recibir mensajes.`);
                }
            } else {
                console.warn(`[cudi-messenger] Mensaje ${data.type} sin targetPeerId o targetPeerId desconocido: ${data.targetPeerId}`);
            }
            break;
        default:
            console.warn(`[cudi-messenger] Tipo de mensaje desconocido: ${data.type}`);
    }
}

function handleSyncLogic(ws, data, message) {
    switch (data.type) {
        case 'join':
            if (data.room) {
                if (!syncRooms.has(data.room)) {
                    syncRooms.set(data.room, new Set());
                }
                const roomClients = syncRooms.get(data.room);
                roomClients.add(ws);
                ws.room = data.room;
                ws.appType = 'cudi-sync';
                console.log(`[cudi-sync] Cliente se unió a la sala: ${data.room}. Clientes en sala: ${roomClients.size}`);

                if (roomClients.size === 2) {
                    const clientsInRoom = Array.from(roomClients);
                    const offerer = clientsInRoom[0];
                    const receiver = clientsInRoom[1];

                    if (offerer.readyState === WebSocket.OPEN) {
                        offerer.send(JSON.stringify({ type: 'start_negotiation', appType: 'cudi-sync' }));
                    }

                    console.log(`[cudi-sync] Dos clientes en sala ${data.room}. Iniciando negociación.`);
                }
            } else {
                console.warn('[cudi-sync] Mensaje de join sin room.');
            }
            break;
        case 'signal':
            if (data.room && syncRooms.has(data.room)) {
                const roomClients = syncRooms.get(data.room);
                roomClients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(message);
                    }
                });
                console.log(`[cudi-sync] Retransmitido 'signal' en sala ${data.room}`);
            } else {
                console.warn(`[cudi-sync] Mensaje de señal sin room o room desconocido: ${data.room}`);
            }
            break;
        default:
            console.warn(`[cudi-sync] Tipo de mensaje desconocido: ${data.type}`);
    }
}
