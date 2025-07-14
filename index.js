const WebSocket = require("ws");
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log(`🔌 Signaling server escuchando en puerto ${PORT}...`);

wss.on("connection", (ws) => {
  ws.on("message", (message) => {
    // Reenvía el mensaje a todos los demás clientes
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on("close", () => {
    console.log("❌ Cliente desconectado");
  });
});
