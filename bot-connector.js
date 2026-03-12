// bot-connector.js — Claude as a player in miniscape
const WebSocket = require('ws');

const GAME_WS = 'ws://localhost:3000'; // change port if needed
const BOT_NAME = 'Claude';
const ANTHROPIC_API_KEY = 'YOUR_KEY_HERE';

const ws = new WebSocket(GAME_WS);

ws.on('open', () => {
  console.log('[bot] connected');
  ws.send(JSON.stringify({ t: 'set_name', name: BOT_NAME }));
});

ws.on('message', async (data) => {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  if (msg.t !== 'chat') return;

  const text = msg.msg || '';
  if (text.startsWith(`${BOT_NAME}:`)) return; // ignore own messages

  const reply = await ask(text);
  if (reply) ws.send(JSON.stringify({ t: 'chat', msg: reply }));
});

ws.on('close', () => console.log('[bot] disconnected'));
ws.on('error', (e) => console.error('[bot] error:', e.message));

async function ask(message) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 150,
      messages: [{ role: 'user', content: message }]
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text?.slice(0, 90) || null;
}
