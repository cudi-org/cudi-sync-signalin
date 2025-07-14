const WebSocket = require("ws");
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`🔌 Signaling server escuchando en puerto ${PORT}...`);

const rooms = new Map();

wss.on("connection", (ws) => {
  ws.roomId = null;

  ws.on("message", (message) => {
    try {
      const msg = JSON.parse(message);

      switch (msg.type) {
        case "join":
          {
            const roomId = msg.room;
            ws.roomId = roomId;

            if (!rooms.has(roomId)) {
              rooms.set(roomId, new Set());
            }

            const clients = rooms.get(roomId);
            clients.add(ws);

            console.log(`Usuario unido a la sala ${roomId}. Total en sala: ${clients.size}`);

            if (clients.size === 2) {
              clients.forEach(client => {
                client.send(JSON.stringify({ type: "ready" }));
              });
            }
          }
          break;

        case "signal":
          {
            const roomId = ws.roomId;
            if (!roomId) return;

            const clients = rooms.get(roomId);
            if (!clients) return;

            clients.forEach(client => {
              if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: "signal", data: msg.data }));
              }
            });
          }
          break;

        default:
          console.log("Mensaje no reconocido", msg);
      }
    } catch (err) {
      console.error("Error procesando mensaje:", err);
    }
  });

  ws.on("close", () => {
    const roomId = ws.roomId;
    if (roomId && rooms.has(roomId)) {
      const clients = rooms.get(roomId);
      clients.delete(ws);
      console.log(`Usuario desconectado de sala ${roomId}.`);
      if (clients.size === 0) {
        rooms.delete(roomId);
      }
    }
  });
});
