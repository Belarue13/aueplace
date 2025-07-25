const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

let redis; // Declare redis here, but don't initialize
let canvas, users, leaderboard, chatHistory;
const clients = new Map();
const ipCooldowns = new Map();
const fingerprintCooldowns = new Map();

async function saveState() {
    const state = { canvas, users, leaderboard, chatHistory };
    await redis.set('aue-place-state', JSON.stringify(state));
}

async function loadState() {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            console.log(`Loading state from Redis, attempt ${attempt}...`);
            const rawData = await redis.get('aue-place-state');

            if (typeof rawData === 'object' && rawData !== null) {
                const state = rawData;
                canvas = state.canvas;
                users = state.users;
                leaderboard = state.leaderboard;
                chatHistory = state.chatHistory;
                console.log("Successfully loaded state from Redis.");
                return; // Exit the function successfully
            }

            console.log(`Attempt ${attempt}: No valid state found in Redis. Retrying in 1 second...`);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second

        } catch (error) {
            console.error(`Attempt ${attempt}: An error occurred while loading state. Retrying...`, error);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second
        }
    }

    console.log("All attempts to load state failed. Initializing fresh state.");
    canvas = Array(64).fill(0).map(() => Array(64).fill('#FFFFFF'));
    users = {};
    leaderboard = {};
    chatHistory = [];
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
        chatHistory.shift();
    }
}

async function startServer() {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`Server started on port ${PORT}.`);
    });

    // Initialize the Redis client here, once the server is running.
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });

    await loadState();

    wss.on('connection', (ws, req) => {
        let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        // Normalize IPv4-mapped IPv6 addresses
        if (ip.startsWith('::ffff:')) {
            ip = ip.substring(7);
        }
        clients.set(ws, { ip });

        ws.send(JSON.stringify({ type: 'canvas', payload: canvas }));
        ws.send(JSON.stringify({ type: 'chatHistory', payload: chatHistory }));
        broadcastLeaderboard();

        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            const { type, payload } = data;
            const clientInfo = clients.get(ws);

            if (type === 'register') {
                const { username, password, visitorId } = payload;
                if (Object.values(users).some(u => u.visitorId === visitorId)) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'This browser is already associated with an account.' }));
                    return;
                }
                if (users[username]) {
                    ws.send(JSON.stringify({ type: 'error', payload: 'Username already exists.' }));
                    return;
                }
                users[username] = { password, visitorId, lastPixelTime: 0 };
                await saveState();
                ws.send(JSON.stringify({ type: 'registered', payload: { username } }));
            } else if (type === 'login') {
                const { username, password, visitorId } = payload;
                if (users[username] && users[username].password === password) {
                    if (users[username].visitorId !== visitorId) {
                        // Optional: Handle login from a different browser.
                        // For now, we'll allow it but you could add stricter rules.
                    }
                    clientInfo.username = username;
                    clientInfo.visitorId = visitorId;
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

                const { x, y, color, clientIP } = payload; // Extract clientIP from the payload
                const user = users[username];
                const now = Date.now();
                // Use the client-reported IP for the cooldown check. Fallback to connection IP if not provided.
                const ipForCooldown = clientIP || clientInfo.ip;
                console.log(`Using IP for cooldown: ${ipForCooldown}`);

                const ipLastPixelTime = ipCooldowns.get(ipForCooldown) || 0;
                const fingerprintLastPixelTime = fingerprintCooldowns.get(clientInfo.visitorId) || 0;
                const userCooldownEnd = user.lastPixelTime + (1000 * 60);
                const ipCooldownEnd = ipLastPixelTime + (1000 * 60);
                const fingerprintCooldownEnd = fingerprintLastPixelTime + (1000 * 60);

                if (now < userCooldownEnd || now < ipCooldownEnd || now < fingerprintCooldownEnd) {
                    const cooldownEnd = Math.max(userCooldownEnd, ipCooldownEnd, fingerprintCooldownEnd);
                    const timeLeft = cooldownEnd - now;
                    ws.send(JSON.stringify({ type: 'cooldown', payload: timeLeft }));
                    return;
                }

                if (x >= 0 && x < 64 && y >= 0 && y < 64) {
                    canvas[y][x] = color;
                    user.lastPixelTime = now;
                    ipCooldowns.set(ipForCooldown, now); // Use the same IP for setting the cooldown
                    fingerprintCooldowns.set(clientInfo.visitorId, now);
                    leaderboard[username] = (leaderboard[username] || 0) + 1;

                    ws.send(JSON.stringify({ type: 'cooldown', payload: 1000 * 60 }));
                    broadcast({ type: 'update', payload: { x, y, color } });
                    broadcastLeaderboard();
                    await saveState();
                }
            } else if (type === 'chatMessage') {
                const username = clientInfo.username;
                if (username) {
                    const chatMessage = { username, message: payload };
                    addChatMessageToHistory(chatMessage);
                    broadcast({ type: 'chatMessage', payload: chatMessage });
                    await saveState();
                }
            }
        });

        ws.on('close', () => {
            clients.delete(ws);
        });
    });
}

startServer(); 