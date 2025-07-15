const WebSocket = require("ws");
const PORT = process.env.PORT || 3000; // Usa el puerto proporcionado por Render o 3000 por defecto
const wss = new WebSocket.Server({ port: PORT });

console.log(`🔌 Signaling server escuchando en puerto ${PORT}...`);

// Mapa para almacenar las salas. Cada sala es un Set de clientes WebSocket.
const rooms = new Map();

wss.on("connection", (ws) => {
  // Inicializa roomId como null para cada nueva conexión
  ws.roomId = null;

  ws.on("message", (message) => {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error("Error: Mensaje WebSocket no es JSON válido:", message);
      return;
    }

    switch (msg.type) {
      case "join":
        {
          const roomId = msg.room;
          ws.roomId = roomId; // Asigna la sala al objeto WebSocket para futuras referencias

          if (!rooms.has(roomId)) {
            rooms.set(roomId, new Set());
          }

          const clients = rooms.get(roomId);
          clients.add(ws);

          console.log(`Usuario unido a la sala ${roomId}. Total en sala: ${clients.size}`);

          // Si hay dos clientes en la sala, ambos están listos para WebRTC
          if (clients.size === 2) {
            clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "ready" }));
                console.log(`Enviando 'ready' a cliente en sala ${roomId}`);
              }
            });
          }
        }
        break;

      case "signal":
        {
          const roomId = ws.roomId;
          if (!roomId) {
            console.warn("Advertencia: Mensaje 'signal' recibido sin roomId asignado.");
            return;
          }

          const clients = rooms.get(roomId);
          if (!clients) {
            console.warn(`Advertencia: Sala ${roomId} no encontrada para mensaje 'signal'.`);
            return;
          }

          // Retransmite el mensaje 'signal' al otro cliente en la misma sala
          clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify(msg)); // Envía el mensaje 'signal' completo tal cual
              // --- ¡ESTE ES EL LOG CRÍTICO PARA DEPURACIÓN! ---
              console.log(
                `<<< SERVER LOG >>> Retransmitiendo señal de un cliente a otro en sala ${roomId}. Contenido (primeros 100 chars): ${JSON.stringify(msg.data).substring(0, 100)}...`
              );
            }
          });
        }
        break;

      case "leave":
        {
          const roomId = ws.roomId;
          if (roomId && rooms.has(roomId)) {
            const clients = rooms.get(roomId);
            clients.delete(ws);
            console.log(`Usuario salió de sala ${roomId}. Clientes restantes: ${clients.size}`);

            if (clients.size === 0) {
              rooms.delete(roomId);
              console.log(`Sala ${roomId} vacía y eliminada.`);
            } else {
              // Notifica a los clientes restantes que alguien se fue
              clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({ type: "cerrar", reason: "peer_left" }));
                  console.log(`Enviando 'cerrar' a cliente en sala ${roomId} por salida de un par.`);
                }
              });
            }
          }
        }
        break;

      default:
        console.log("Mensaje no reconocido:", msg);
        break;
    }
  });

  ws.on("close", () => {
    const roomId = ws.roomId;
    if (roomId && rooms.has(roomId)) {
      const clients = rooms.get(roomId);
      clients.delete(ws);
      console.log(`Usuario desconectado de sala ${roomId}. Clientes restantes: ${clients.size}`);

      if (clients.size === 0) {
        rooms.delete(roomId);
        console.log(`Sala ${roomId} vacía y eliminada por desconexión.`);
      } else {
        // Notifica a los clientes restantes que el par se desconectó inesperadamente
        clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "cerrar", reason: "peer_disconnected" }));
            console.log(`Enviando 'cerrar' a cliente en sala ${roomId} por desconexión de un par.`);
          }
        });
      }
    }
  });

  ws.on("error", (err) => {
    console.error("Error en conexión WebSocket:", err);
  });
});
