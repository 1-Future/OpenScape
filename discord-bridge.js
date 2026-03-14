// discord-bridge.js — Bridges Discord channel ↔ OpenScape game chat
// Run alongside server.js: node discord-bridge.js

const WebSocket = require('ws');

const GAME_WS = 'ws://localhost:2222';
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';
const CHANNEL_ID = '1480654372131180635';
const BOT_USER_ID = '1464768627709313044';
const DISCORD_GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

let gameWs = null;
let discordWs = null;
let heartbeatInterval = null;
let sessionId = null;
let seq = null;
let resumeUrl = null;

// ── Game WebSocket ────────────────────────────────────────────────────────────
function connectGame() {
  gameWs = new WebSocket(GAME_WS);
  gameWs.on('open', () => {
    console.log('[bridge] Connected to game server');
    gameWs.send(JSON.stringify({ t: 'bot_identify' }));
  });
  gameWs.on('close', () => {
    console.log('[bridge] Game connection lost, reconnecting in 5s...');
    setTimeout(connectGame, 5000);
  });
  gameWs.on('error', (e) => console.error('[bridge] Game error:', e.message));
}

function sendToGame(name, text) {
  if (gameWs && gameWs.readyState === WebSocket.OPEN) {
    gameWs.send(JSON.stringify({ t: 'discord_chat', name, msg: text }));
  }
}

// ── Discord Gateway ───────────────────────────────────────────────────────────
function connectDiscord() {
  const url = resumeUrl || DISCORD_GATEWAY;
  discordWs = new WebSocket(url);

  discordWs.on('open', () => {
    console.log('[bridge] Connected to Discord gateway');
    if (sessionId && seq !== null) {
      // Resume
      discordWs.send(JSON.stringify({
        op: 6,
        d: { token: BOT_TOKEN, session_id: sessionId, seq }
      }));
    }
  });

  discordWs.on('message', (raw) => {
    const msg = JSON.parse(raw);
    seq = msg.s ?? seq;

    switch (msg.op) {
      case 10: { // Hello
        const interval = msg.d.heartbeat_interval;
        startHeartbeat(interval);
        // Identify
        discordWs.send(JSON.stringify({
          op: 2,
          d: {
            token: BOT_TOKEN,
            intents: (1 << 9) | (1 << 15), // GUILD_MESSAGES | MESSAGE_CONTENT
            properties: { os: 'windows', browser: 'openscape', device: 'openscape' }
          }
        }));
        break;
      }
      case 11: // Heartbeat ACK
        break;
      case 1: // Heartbeat request
        discordWs.send(JSON.stringify({ op: 1, d: seq }));
        break;
      case 7: // Reconnect
        console.log('[bridge] Discord requested reconnect');
        discordWs.close();
        break;
      case 9: // Invalid session
        console.log('[bridge] Invalid session, re-identifying in 5s...');
        sessionId = null;
        seq = null;
        setTimeout(connectDiscord, 5000);
        break;
      case 0: // Dispatch
        handleDispatch(msg.t, msg.d);
        break;
    }
  });

  discordWs.on('close', (code) => {
    console.log(`[bridge] Discord disconnected (${code}), reconnecting in 5s...`);
    clearInterval(heartbeatInterval);
    setTimeout(connectDiscord, 5000);
  });

  discordWs.on('error', (e) => console.error('[bridge] Discord error:', e.message));
}

function startHeartbeat(interval) {
  clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    if (discordWs && discordWs.readyState === WebSocket.OPEN) {
      discordWs.send(JSON.stringify({ op: 1, d: seq }));
    }
  }, interval);
}

function handleDispatch(event, data) {
  if (event === 'READY') {
    sessionId = data.session_id;
    resumeUrl = data.resume_gateway_url;
    console.log(`[bridge] Discord ready as ${data.user.username}#${data.user.discriminator}`);
    return;
  }

  if (event === 'MESSAGE_CREATE') {
    // Only care about messages in our channel
    if (data.channel_id !== CHANNEL_ID) return;
    // Ignore messages from the webhook (those are game→discord, don't echo back)
    if (data.webhook_id) return;

    const isBot = data.author.id === BOT_USER_ID;
    const name = isBot ? 'AI' : (data.author.username || 'Discord');
    const text = data.content || '';
    if (!text) return;

    console.log(`[bridge] Discord → Game: ${name}: ${text}`);
    sendToGame(name, text);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('[bridge] Starting OpenScape ↔ Discord bridge...');
connectGame();
connectDiscord();
