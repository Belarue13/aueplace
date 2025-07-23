const canvasContainer = document.getElementById('canvas-container');
const colorInput = document.getElementById('color-input');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');

// Auth elements
const userAuth = document.getElementById('user-auth');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginButton = document.getElementById('login-button');
const registerButton = document.getElementById('register-button');
const userInfo = document.getElementById('user-info');
const usernameDisplay = document.getElementById('username-display');
const logoutButton = document.getElementById('logout-button');

// Leaderboard
const leaderboardList = document.getElementById('leaderboard-list');
const cooldownContainer = document.getElementById('cooldown-container');
const cooldownTimer = document.getElementById('cooldown-timer');

let loggedInUser = null;
let cooldownInterval = null;
let visitorId = null;

// Initialize FingerprintJS and get the visitor ID
FingerprintJS.load()
    .then(fp => fp.get())
    .then(result => {
        visitorId = result.visitorId;
    });

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}`);

function drawCanvas(canvas) {
    canvasContainer.innerHTML = '';
    for (let y = 0; y < canvas.length; y++) {
        for (let x = 0; x < canvas[y].length; x++) {
            const pixel = document.createElement('div');
            pixel.classList.add('pixel');
            pixel.style.backgroundColor = canvas[y][x];
            pixel.dataset.x = x;
            pixel.dataset.y = y;
            pixel.addEventListener('click', () => {
                const selectedColor = colorInput.value;
                ws.send(JSON.stringify({
                    type: 'placePixel',
                    payload: { x, y, color: selectedColor }
                }));
            });
            canvasContainer.appendChild(pixel);
        }
    }
}

function updatePixel(x, y, color) {
    const pixel = document.querySelector(`.pixel[data-x='${x}'][data-y='${y}']`);
    if (pixel) {
        pixel.style.backgroundColor = color;
    }
}

function addChatMessage({ username, message }) {
    const messageElement = document.createElement('div');
    messageElement.innerHTML = `<strong>${username}:</strong> ${message}`;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateLeaderboard(leaderboard) {
    leaderboardList.innerHTML = '';
    leaderboard.forEach(([username, score]) => {
        const li = document.createElement('li');
        li.textContent = `${username}: ${score}`;
        leaderboardList.appendChild(li);
    });
}

function setLoggedIn(username) {
    loggedInUser = username;
    userAuth.style.display = 'none';
    userInfo.style.display = 'block';
    usernameDisplay.textContent = username;
}

function setLoggedOut() {
    loggedInUser = null;
    userAuth.style.display = 'flex';
    userInfo.style.display = 'none';
}

function startCooldownTimer(ms) {
    if (cooldownInterval) {
        clearInterval(cooldownInterval);
    }

    cooldownContainer.style.display = 'block';
    let timeLeft = Math.ceil(ms / 1000);

    const updateTimer = () => {
        if (timeLeft <= 0) {
            cooldownContainer.style.display = 'none';
            clearInterval(cooldownInterval);
        } else {
            cooldownTimer.textContent = `${timeLeft}s`;
            timeLeft--;
        }
    };

    updateTimer();
    cooldownInterval = setInterval(updateTimer, 1000);
}

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    switch (data.type) {
        case 'canvas':
            drawCanvas(data.payload);
            break;
        case 'update':
            const { x, y, color } = data.payload;
            updatePixel(x, y, color);
            break;
        case 'chatHistory':
            chatMessages.innerHTML = '';
            data.payload.forEach(addChatMessage);
            break;
        case 'chatMessage':
            addChatMessage(data.payload);
            break;
        case 'leaderboard':
            updateLeaderboard(data.payload);
            break;
        case 'cooldown':
            startCooldownTimer(data.payload);
            break;
        case 'registered':
            alert(`Registered as ${data.payload.username}. You can now log in.`);
            break;
        case 'loggedIn':
            setLoggedIn(data.payload.username);
            break;
        case 'error':
            alert(data.payload);
            break;
    }
};

registerButton.addEventListener('click', () => {
    const username = document.getElementById('register-username').value;
    const password = document.getElementById('register-password').value;
    if (username && password) {
        if (!visitorId) {
            alert('Still generating a unique browser ID, please wait a moment and try again.');
            return;
        }
        ws.send(JSON.stringify({ type: 'register', payload: { username, password, visitorId } }));
    }
});

loginButton.addEventListener('click', () => {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    if (username && password) {
        if (!visitorId) {
            alert('Still generating a unique browser ID, please wait a moment and try again.');
            return;
        }
        ws.send(JSON.stringify({ type: 'login', payload: { username, password, visitorId } }));
    }
});

logoutButton.addEventListener('click', () => {
    setLoggedOut();
});

chatSend.addEventListener('click', () => {
    const message = chatInput.value;
    if (message) {
        ws.send(JSON.stringify({ type: 'chatMessage', payload: message }));
        chatInput.value = '';
    }
});

chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        chatSend.click();
    }
}); 