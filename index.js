const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: process.env.PORT || 8080 });

const appClients = {
    'cudi-sync': {},
    'cudi-messenger': new Map()
};

wss.on('connection', ws => {
    console.log('Cliente conectado');

    ws.on('message', message => {
        const parsedMessage = JSON.parse(message);
        const { type, room, appType, senderId, data } = parsedMessage;

        if (!appType) {
            console.warn('Mensaje recibido sin appType. Ignorando:', parsedMessage);
            return;
        }

        switch (appType) {
            case 'cudi-sync':
                console.log(`[CUDI Sync] Mensaje recibido: ${type} en sala: ${room}`);
                switch (type) {
                    case 'join':
                        appClients['cudi-sync'][room] = ws;
                        ws.currentSyncRoom = room;
                        console.log(`[CUDI Sync] Cliente ${room} se ha unido.`);
                        break;
                    case 'signal':
                        const targetSyncClientWs = appClients['cudi-sync'][room];
                        if (targetSyncClientWs && targetSyncClientWs.readyState === WebSocket.OPEN) {
                            targetSyncClientWs.send(JSON.stringify(parsedMessage));
                            console.log(`[CUDI Sync] Señal reenviada a ${room} desde ${senderId || 'desconocido'}.`);
                        } else {
                            console.warn(`[CUDI Sync] Cliente ${room} no encontrado o no está abierto.`);
                        }
                        break;
                    case 'ready':
                        break;
                    case 'cerrar':
                        const syncClosedTargetWs = appClients['cudi-sync'][room];
                        if (syncClosedTargetWs && syncClosedTargetWs.readyState === WebSocket.OPEN) {
                            syncClosedTargetWs.send(JSON.stringify({ type: "cerrar", reason: "peer_closed" }));
                        }
                        break;
                    default:
                        console.log(`[CUDI Sync] Tipo de mensaje desconocido: ${type}`);
                }
                break;

            case 'cudi-messenger':
                console.log(`[CUDI Messenger] Mensaje recibido: ${type} en sala: ${room}`);
                switch (type) {
                    case 'join':
                        if (!room) {
                            console.warn("[CUDI Messenger] Mensaje 'join' sin room. Ignorando.");
                            return;
                        }
                        if (!appClients['cudi-messenger'].has(room)) {
                            appClients['cudi-messenger'].set(room, new Set());
                        }
                        const messengerRoomClients = appClients['cudi-messenger'].get(room);
                        messengerRoomClients.add(ws);
                        ws.currentMessengerRoom = room;
                        console.log(`[CUDI Messenger] Cliente se unió a la sala: ${room}. Clientes en sala: ${messengerRoomClients.size}`);

                        if (messengerRoomClients.size === 2) {
                            messengerRoomClients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: "ready", room: room, appType: 'cudi-messenger' }));
                                }
                            });
                        } else if (messengerRoomClients.size > 2) {
                            console.warn(`[CUDI Messenger] Advertencia: Más de 2 clientes en la sala ${room}.`);
                        }
                        break;

                    case 'signal':
                        if (!room) {
                            console.warn("[CUDI Messenger] Mensaje 'signal' sin room. Ignorando.");
                            return;
                        }
                        const clientsInTargetMessengerRoom = appClients['cudi-messenger'].get(room);
                        if (clientsInTargetMessengerRoom) {
                            clientsInTargetMessengerRoom.forEach(client => {
                                if (client !== ws && client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({
                                        type: "signal",
                                        room: room,
                                        senderId: senderId,
                                        data: data,
                                        appType: 'cudi-messenger'
                                    }));
                                }
                            });
                        } else {
                            console.warn(`[CUDI Messenger] Sala ${room} no encontrada para señalización.`);
                        }
                        break;
                    
                    case 'cerrar':
                         if (!room) {
                             console.warn("[CUDI Messenger] Mensaje 'cerrar' sin room. Ignorando.");
                             return;
                         }
                         const messengerClosingRoomClients = appClients['cudi-messenger'].get(room);
                         if (messengerClosingRoomClients) {
                             messengerClosingRoomClients.forEach(client => {
                                 if (client !== ws && client.readyState === WebSocket.OPEN) {
                                     client.send(JSON.stringify({ type: "cerrar", room: room, reason: "peer_disconnected", appType: 'cudi-messenger' }));
                                 }
                             });
                         }
                         break;

                    default:
                        console.log(`[CUDI Messenger] Tipo de mensaje desconocido: ${type}`);
                }
                break;

            default:
                console.warn(`appType desconocido: ${appType}. Mensaje ignorado.`);
        }
    });

    ws.on('close', () => {
        console.log('Cliente desconectado');
        if (ws.currentSyncRoom && appClients['cudi-sync'][ws.currentSyncRoom]) {
            console.log(`[CUDI Sync] Cliente ${ws.currentSyncRoom} removido.`);
            delete appClients['cudi-sync'][ws.currentSyncRoom];
        }

        if (ws.currentMessengerRoom && appClients['cudi-messenger'].has(ws.currentMessengerRoom)) {
            const roomClients = appClients['cudi-messenger'].get(ws.currentMessengerRoom);
            roomClients.delete(ws);
            console.log(`[CUDI Messenger] Cliente removido de sala: ${ws.currentMessengerRoom}. Clientes restantes: ${roomClients.size}`);

            if (roomClients.size === 0) {
                appClients['cudi-messenger'].delete(ws.currentMessengerRoom);
                console.log(`[CUDI Messenger] Sala ${ws.currentMessengerRoom} ahora está vacía y ha sido eliminada.`);
            } else {
                roomClients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: "cerrar", room: ws.currentMessengerRoom, reason: "peer_disconnected", appType: 'cudi-messenger' }));
                    }
                });
            }
        }
    });

    ws.on('error', error => {
        console.error('Error de WebSocket:', error);
    });
});

console.log('Servidor WebSocket iniciado en el puerto', process.env.PORT || 8080);

