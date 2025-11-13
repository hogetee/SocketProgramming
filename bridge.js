// bridge.js
const net = require("node:net");
const { WebSocketServer } = require("ws");

const TCP_HOST = "127.0.0.1";
const TCP_PORT = 5050;
const WS_PORT = 3000;

const wss = new WebSocketServer({ port: WS_PORT, path: "/ws" });

wss.on("connection", (ws) => {
  const socket = net.createConnection(TCP_PORT, TCP_HOST);
  const closeBoth = () => {
    if (ws.readyState === ws.OPEN) ws.close();
    socket.end();
  };

  ws.on("message", (msg) => socket.write(msg));
  ws.on("close", closeBoth);
  ws.on("error", closeBoth);

  socket.on("data", (chunk) => ws.send(chunk.toString()));
  socket.on("end", closeBoth);
  socket.on("error", closeBoth);
});

console.log(`WebSocket bridge listening on ws://localhost:${WS_PORT}/ws`);
