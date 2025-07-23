const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Initialize a 64x64 canvas with a default color (e.g., white)
const canvasSize = 64;
const canvas = Array(canvasSize).fill(0).map(() => Array(canvasSize).fill('#FFFFFF'));

const clients = new Map();
const users = {}; // In-memory user store
const leaderboard = {}; // In-memory leaderboard
const ipCooldowns = new Map(); // Tracks last pixel placement time per IP
const chatHistory = []; // Stores last 10 chat messages

function broadcast(message) {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastLeaderboard() {
    const sortedLeaderboard = Object.entries(leaderboard)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    broadcast({ type: 'leaderboard', payload: sortedLeaderboard });
}

function addChatMessageToHistory(message) {
    chatHistory.push(message);
    if (chatHistory.length > 10) {
        chatHistory.shift(); // Keep only the last 10 messages
    }
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    clients.set(ws, { ip }); // Store IP with the connection

    // Send initial state
    ws.send(JSON.stringify({ type: 'canvas', payload: canvas }));
    ws.send(JSON.stringify({ type: 'chatHistory', payload: chatHistory }));
    broadcastLeaderboard();

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const { type, payload } = data;
        const clientInfo = clients.get(ws);

        if (type === 'register') {
            const { username, password } = payload;
            if (users[username]) {
                ws.send(JSON.stringify({ type: 'error', payload: 'Username already exists.' }));
                return;
            }
            users[username] = { password, lastPixelTime: 0 };
            ws.send(JSON.stringify({ type: 'registered', payload: { username } }));
        } else if (type === 'login') {
            const { username, password } = payload;
            if (users[username] && users[username].password === password) {
                clientInfo.username = username;
                ws.send(JSON.stringify({ type: 'loggedIn', payload: { username } }));
            } else {
                ws.send(JSON.stringify({ type: 'error', payload: 'Invalid username or password.' }));
            }
        } else if (type === 'placePixel') {
            const username = clientInfo.username;
            if (!username) {
                ws.send(JSON.stringify({ type: 'error', payload: 'You must be logged in to place a pixel.' }));
                return;
            }

            const { x, y, color } = payload;
            const user = users[username];
            const now = Date.now();
            const ipLastPixelTime = ipCooldowns.get(clientInfo.ip) || 0;

            if (now - user.lastPixelTime < 1000 * 60) { // 1 minute user cooldown
                ws.send(JSON.stringify({ type: 'error', payload: 'You can only place a pixel every minute.' }));
                return;
            }
            if (now - ipLastPixelTime < 1000 * 60) { // 1 minute IP cooldown
                ws.send(JSON.stringify({ type: 'error', payload: 'This device has already placed a pixel recently. Please wait.' }));
                return;
            }
            
            if (x >= 0 && x < canvasSize && y >= 0 && y < canvasSize) {
                canvas[y][x] = color;
                user.lastPixelTime = now;
                ipCooldowns.set(clientInfo.ip, now);
                leaderboard[username] = (leaderboard[username] || 0) + 1;
                
                broadcast({ type: 'update', payload: { x, y, color } });
                broadcastLeaderboard();
            }
        } else if (type === 'chatMessage') {
            const username = clientInfo.username;
            if (username) {
                const chatMessage = { username, message: payload };
                addChatMessageToHistory(chatMessage);
                broadcast({ type: 'chatMessage', payload: chatMessage });
            }
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });
});

server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
}); 