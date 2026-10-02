// Wriggle — self-hosted authoritative multiplayer server
// Run with: node server.js
// Serves the client from /public and runs the game loop over WebSocket.

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const WORLD_W = 2000;
const WORLD_H = 1500;
const TICK_MS = 50; // 20 ticks/sec
const SEG_SPACING = 6;
const MAX_FOOD = 220;
const COLORS = ['#6FE0A8', '#8BB8FF', '#FFD27A', '#FF9B9B', '#C58BFF', '#7AE0D8', '#F08A5D', '#B5E655'];
const BOT_COUNT = 5;
const BOT_COLORS = ['#E85D5D', '#E8B85D', '#C58BFF', '#5D9DE8', '#8FD15D'];
let botNameIdx = 0;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

let players = new Map(); // id -> player object
let food = new Map();    // id -> food object
let colorIdx = 0;

function uid() { return crypto.randomBytes(8).toString('hex'); }

function randPos(margin) {
  return {
    x: margin + Math.random() * (WORLD_W - margin * 2),
    y: margin + Math.random() * (WORLD_H - margin * 2),
  };
}

function makeFood(x, y) {
  const id = uid();
  const f = {
    id,
    x, y,
    r: 3 + Math.random() * 3,
    hue: Math.random() < 0.5 ? '#FFD23F' : '#C58BFF',
  };
  food.set(id, f);
  return f;
}

function seedFood() {
  for (let i = 0; i < 150; i++) {
    const p = randPos(20);
    makeFood(p.x, p.y);
  }
}

function makePlayer(ws, name) {
  const id = uid();
  const p = randPos(200);
  const segs = [];
  for (let i = 0; i < 10; i++) segs.push({ x: p.x - i * SEG_SPACING, y: p.y });
  const player = {
    id, ws,
    name: (name || 'Player').slice(0, 16),
    color: COLORS[colorIdx % COLORS.length],
    segs, angle: 0,
    targetAngle: 0,
    boost: false,
    alive: true,
    lastInputAt: Date.now(),
  };
  colorIdx++;
  players.set(id, player);
  return player;
}

function makeBot() {
  const id = uid();
  const p = randPos(200);
  const segs = [];
  const len = 10 + Math.floor(Math.random() * 15);
  for (let i = 0; i < len; i++) segs.push({ x: p.x - i * SEG_SPACING, y: p.y });
  botNameIdx++;
  const bot = {
    id, ws: null, isBot: true,
    name: 'Bot ' + botNameIdx,
    color: BOT_COLORS[botNameIdx % BOT_COLORS.length],
    segs, angle: Math.random() * Math.PI * 2,
    targetAngle: 0,
    boost: false,
    alive: true,
    wanderAngle: Math.random() * Math.PI * 2,
    wanderTimer: 0,
    lastInputAt: Date.now(),
  };
  players.set(id, bot);
  return bot;
}

function respawnBotLater(delayMs) {
  setTimeout(() => makeBot(), delayMs);
}

function explodePlayer(p) {
  p.segs.forEach((s, i) => {
    if (i % 2 !== 0) return;
    makeFood(
      Math.max(10, Math.min(WORLD_W - 10, s.x + (Math.random() - 0.5) * 10)),
      Math.max(10, Math.min(WORLD_H - 10, s.y + (Math.random() - 0.5) * 10))
    );
  });
}

function killPlayer(p) {
  if (!p.alive) return;
  p.alive = false;
  explodePlayer(p);
  if (p.isBot) {
    players.delete(p.id);
    respawnBotLater(1200 + Math.random() * 800);
  } else {
    send(p.ws, { type: 'dead', length: p.segs.length });
  }
}

function angleTo(x, y, tx, ty) { return Math.atan2(ty - y, tx - x); }

function updateBotIntent(bot) {
  bot.wanderTimer--;
  if (bot.wanderTimer <= 0) {
    bot.wanderAngle += (Math.random() - 0.5) * 1.2;
    bot.wanderTimer = 40 + Math.random() * 40;
  }
  const head = bot.segs[0];
  let desired = bot.wanderAngle;

  let nearestFood = null, nearestDist = 9999;
  for (const f of food.values()) {
    if (f.x < 40 || f.x > WORLD_W - 40 || f.y < 40 || f.y > WORLD_H - 40) continue;
    const d = Math.hypot(f.x - head.x, f.y - head.y);
    if (d < 140 && d < nearestDist) { nearestDist = d; nearestFood = f; }
  }
  if (nearestFood) desired = angleTo(head.x, head.y, nearestFood.x, nearestFood.y);

  const lookAhead = 48;
  const lookX = head.x + Math.cos(bot.angle) * lookAhead;
  const lookY = head.y + Math.sin(bot.angle) * lookAhead;
  let hazardAngle = null, hazardDist = 9999;
  for (const other of players.values()) {
    if (other.id === bot.id || !other.alive) continue;
    for (let i = 0; i < other.segs.length; i += 2) {
      const d = Math.hypot(other.segs[i].x - lookX, other.segs[i].y - lookY);
      if (d < 26 && d < hazardDist) { hazardDist = d; hazardAngle = angleTo(other.segs[i].x, other.segs[i].y, head.x, head.y); }
    }
  }
  if (head.x < 45) hazardAngle = 0;
  else if (head.x > WORLD_W - 45) hazardAngle = Math.PI;
  else if (head.y < 45) hazardAngle = Math.PI / 2;
  else if (head.y > WORLD_H - 45) hazardAngle = -Math.PI / 2;

  if (hazardAngle !== null) { desired = hazardAngle; bot.wanderAngle = hazardAngle; }
  else bot.wanderAngle += (Math.random() - 0.5) * 0.02;

  bot.targetAngle = desired;
}

function moveWorm(p, speed) {
  let diff = p.targetAngle - p.angle;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  p.angle += diff * 0.15;
  const head = p.segs[0];
  const nx = head.x + Math.cos(p.angle) * speed;
  const ny = head.y + Math.sin(p.angle) * speed;
  p.segs.unshift({ x: nx, y: ny });
  p.segs.pop();
}

function growWorm(p, amount) {
  const tail = p.segs[p.segs.length - 1];
  for (let i = 0; i < amount; i++) p.segs.push({ x: tail.x, y: tail.y });
}

function tick() {
  const now = Date.now();

  for (const p of players.values()) {
    if (!p.alive) continue;
    if (!p.isBot && now - p.lastInputAt > 15000) { killPlayer(p); continue; }
    if (p.isBot) updateBotIntent(p);

    const speed = p.boost && p.segs.length > 8 ? 3.2 : 1.9;
    moveWorm(p, speed);
    if (p.boost && p.segs.length > 8 && Math.random() < 0.3) p.segs.pop();

    const head = p.segs[0];
    if (head.x < 8 || head.x > WORLD_W - 8 || head.y < 8 || head.y > WORLD_H - 8) {
      killPlayer(p);
      continue;
    }
  }

  // food consumption
  for (const p of players.values()) {
    if (!p.alive) continue;
    const head = p.segs[0];
    for (const f of food.values()) {
      if (Math.hypot(f.x - head.x, f.y - head.y) < 10 + f.r) {
        food.delete(f.id);
        growWorm(p, 3);
        break;
      }
    }
  }
  while (food.size < MAX_FOOD) {
    const p = randPos(20);
    makeFood(p.x, p.y);
  }

  // body collisions (skip own body; own first 8 segs are a neck buffer for others)
  const alivePlayers = [...players.values()].filter(p => p.alive);
  for (const p of alivePlayers) {
    const head = p.segs[0];
    for (const other of alivePlayers) {
      if (other.id === p.id) continue;
      for (let i = 0; i < other.segs.length; i++) {
        if (Math.hypot(other.segs[i].x - head.x, other.segs[i].y - head.y) < 8) {
          killPlayer(p);
          break;
        }
      }
      if (!p.alive) break;
    }
  }

  broadcastState();
}

function send(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastState() {
  const foodArr = [...food.values()];
  const playersArr = [...players.values()].map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    angle: p.angle,
    alive: p.alive,
    segs: p.segs.filter((_, i) => i % 2 === 0).map(s => [Math.round(s.x), Math.round(s.y)]),
  }));
  const payload = JSON.stringify({ type: 'state', players: playersArr, food: foodArr, world: { w: WORLD_W, h: WORLD_H } });
  for (const p of players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) p.ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  let player = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'join') {
      player = makePlayer(ws, msg.name);
      send(ws, { type: 'welcome', id: player.id, world: { w: WORLD_W, h: WORLD_H } });
      return;
    }
    if (!player) return;

    if (msg.type === 'input') {
      if (typeof msg.angle === 'number') player.targetAngle = msg.angle;
      player.boost = !!msg.boost;
      player.lastInputAt = Date.now();
    } else if (msg.type === 'respawn') {
      if (!player.alive) {
        const p = randPos(200);
        player.segs = [];
        for (let i = 0; i < 10; i++) player.segs.push({ x: p.x - i * SEG_SPACING, y: p.y });
        player.angle = 0;
        player.targetAngle = 0;
        player.alive = true;
      }
    }
  });

  ws.on('close', () => {
    if (player) players.delete(player.id);
  });
});

seedFood();
for (let i = 0; i < BOT_COUNT; i++) makeBot();
setInterval(tick, TICK_MS);

server.listen(PORT, () => {
  console.log(`Wriggle server running on port ${PORT}`);
});
