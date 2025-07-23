const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- State Variables ---
let canvas, users, leaderboard, chatHistory;
const clients = new Map();
const ipCooldowns = new Map();

// --- State Management Functions ---
function saveState() {
    const state = {
        canvas,
        users,
        leaderboard,
        chatHistory
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
}

function loadState() {
    if (fs.existsSync(DATA_FILE)) {
        const rawData = fs.readFileSync(DATA_FILE);
        const state = JSON.parse(rawData);
        canvas = state.canvas;
        users = state.users;
        leaderboard = state.leaderboard;
        chatHistory = state.chatHistory;
    } else {
        // Initialize default state if no file exists
        canvas = Array(64).fill(0).map(() => Array(64).fill('#FFFFFF'));
        users = {};
        leaderboard = {};
        chatHistory = [];
    }
}

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
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    clients.set(ws, { ip });

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
            saveState();
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

            if (now - user.lastPixelTime < 1000 * 60) {
                ws.send(JSON.stringify({ type: 'error', payload: 'You can only place a pixel every minute.' }));
                return;
            }
            if (now - ipLastPixelTime < 1000 * 60) {
                ws.send(JSON.stringify({ type: 'error', payload: 'This device has already placed a pixel recently. Please wait.' }));
                return;
            }
            
            if (x >= 0 && x < 64 && y >= 0 && y < 64) {
                canvas[y][x] = color;
                user.lastPixelTime = now;
                ipCooldowns.set(clientInfo.ip, now);
                leaderboard[username] = (leaderboard[username] || 0) + 1;
                
                broadcast({ type: 'update', payload: { x, y, color } });
                broadcastLeaderboard();
                saveState();
            }
        } else if (type === 'chatMessage') {
            const username = clientInfo.username;
            if (username) {
                const chatMessage = { username, message: payload };
                addChatMessageToHistory(chatMessage);
                broadcast({ type: 'chatMessage', payload: chatMessage });
                saveState();
            }
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });
});

// Load initial state and start the server
loadState();
server.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
}); 