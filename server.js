'use strict';
// EDGE CLUB — dependency-free HTTP + WebSocket server.
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const STAGES = 5;
const TURN_REVEAL_MS = Math.max(10, Number(process.env.TURN_REVEAL_MS || 2100));
const STAGE_REVEAL_MS = Math.max(10, Number(process.env.STAGE_REVEAL_MS || 4400));
const rooms = new Map();
const publicDir = path.join(__dirname, 'public');

function roomCode() {
  let code;
  do { code = Array.from(crypto.randomBytes(6), n => CHARSET[n % CHARSET.length]).join(''); }
  while (rooms.has(code));
  return code;
}
function cleanName(raw) {
  return typeof raw === 'string' ? [...raw.trim().replace(/[<>\r\n\t]/g, '')].slice(0, 12).join('') : '';
}
function safeId(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{16,100}$/.test(id); }
function newPlayer(id, name, peer) {
  return { id, name, ws: peer, score: 0, position: 0, status: 'active', choice: null, rematchReady: false };
}
function makeRoom(code, creator) {
  return { code, players: [creator], status: 'lobby', phase: 'choose', stageIndex: 0,
    limit: null, lastReveal: null, history: [], winner: null, timer: null, lastActive: Date.now() };
}
function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }
function broadcast(room) {
  room.lastActive = Date.now();
  for (const p of room.players) {
    if (p.ws) p.ws.send({ type: 'state', selfId: p.id, room: snapshot(room) });
  }
}
function snapshot(room) {
  return {
    code: room.code, status: room.status, phase: room.phase, stage: room.stageIndex + 1,
    totalStages: STAGES, hint: '前4步必安全，危险线位于第5—9步',
    players: room.players.map(p => ({ id: p.id, name: p.name, connected: Boolean(p.ws && !p.ws.closed),
      score: p.score, position: p.position, pot: p.position * 10, status: p.status,
      committed: p.choice !== null, rematchReady: p.rematchReady })),
    lastReveal: room.lastReveal, history: room.history.slice(-7), winner: room.winner
  };
}
function makeStage(room) {
  room.phase = 'choose'; room.limit = crypto.randomInt(5, 10);
  room.lastReveal = null;
  room.players.forEach(p => { p.position = 0; p.status = 'active'; p.choice = null; });
  broadcast(room);
}
function startMatch(room) {
  clearTimer(room);
  room.status = 'playing'; room.stageIndex = 0; room.winner = null; room.history = [];
  room.players.forEach(p => { p.score = 0; p.rematchReady = false; });
  makeStage(room);
}
function finishMatch(room) {
  room.status = 'finished'; room.phase = 'finished'; room.lastReveal = null;
  const [a, b] = room.players;
  room.winner = a.score === b.score ? 'tie' : (a.score > b.score ? a.id : b.id);
  room.history.push({ message: a.score === b.score ? '平局！势均力敌。' : `🏆 ${a.score > b.score ? a.name : b.name} 获得胜利！`, stage: STAGES });
  broadcast(room);
}
function resolveChoices(room) {
  if (room.status !== 'playing' || room.phase !== 'choose') return;
  const active = room.players.filter(p => p.status === 'active');
  if (!active.length || active.some(p => p.choice === null)) return;
  const actions = [];
  for (const p of active) {
    const choice = p.choice;
    let outcome;
    if (choice === 'bank') {
      p.score += p.position * 10;
      p.status = 'banked'; outcome = 'banked';
    } else {
      p.position += choice;
      if (p.position > room.limit) {
        p.status = 'fallen'; outcome = 'fallen';
      } else outcome = 'safe';
    }
    actions.push({ id: p.id, name: p.name, choice, outcome, position: p.position, score: p.score });
    const verb = outcome === 'banked' ? `收手，存入 ${p.position * 10} 分` :
      outcome === 'fallen' ? `冲了 ${choice} 步，掉下悬崖！` : `安全前进 ${choice} 步`;
    room.history.push({ message: `${p.name} ${verb}`, stage: room.stageIndex + 1 });
    p.choice = null;
  }
  const stageEnd = room.players.every(p => p.status !== 'active');
  room.phase = 'reveal';
  room.lastReveal = { actions, stageEnd, limit: stageEnd ? room.limit : null };
  broadcast(room);
  clearTimer(room);
  room.timer = setTimeout(() => {
    room.timer = null;
    if (room.status !== 'playing' || room.phase !== 'reveal') return;
    if (stageEnd) {
      if (room.stageIndex === STAGES - 1) finishMatch(room);
      else { room.stageIndex++; makeStage(room); }
    } else { room.lastReveal = null; room.phase = 'choose'; broadcast(room); }
  }, stageEnd ? STAGE_REVEAL_MS : TURN_REVEAL_MS);
}
function isWebSocketOpen(peer) { return peer && !peer.closed && !peer.socket.destroyed; }
function handleMessage(peer, data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  const type = data.type;
  if (type === 'ping') { peer.send({ type: 'pong' }); return; }
  if (type === 'create' || type === 'join') {
    const id = data.playerId, name = cleanName(data.name);
    if (!safeId(id) || !name) return peer.send({ type: 'error', message: '请填写昵称后重试。' });
    if (peer.roomId) return peer.send({ type: 'error', message: '你已经在房间里了。' });
    let room, player;
    if (type === 'create') {
      const code = roomCode();
      player = newPlayer(id, name, peer);
      room = makeRoom(code, player); rooms.set(code, room);
    } else {
      const code = String(data.code || '').trim().toUpperCase();
      room = rooms.get(code);
      if (!room) return peer.send({ type: 'error', message: '找不到这个房间，请核对房间码。' });
      player = room.players.find(p => p.id === id);
      if (!player) {
        if (room.players.length >= 2) return peer.send({ type: 'error', message: '房间已经满员啦。' });
        player = newPlayer(id, name, peer); room.players.push(player);
      } else {
        if (isWebSocketOpen(player.ws) && player.ws !== peer) player.ws.close();
        player.ws = peer;
      }
    }
    peer.roomId = room.code; peer.playerId = id;
    peer.send({ type: 'joined', code: room.code });
    broadcast(room);
    return;
  }
  if (!peer.roomId || !peer.playerId) return peer.send({ type: 'error', message: '请先加入房间。' });
  const room = rooms.get(peer.roomId);
  const player = room?.players.find(p => p.id === peer.playerId && p.ws === peer);
  if (!room || !player) return;
  if (type === 'start') {
    if (room.status !== 'lobby' || room.players.length !== 2 || room.players.some(p => !isWebSocketOpen(p.ws)))
      return peer.send({ type: 'error', message: '需要两位玩家都在线才能开始。' });
    if (player.id !== room.players[0].id) return peer.send({ type: 'error', message: '由房主开始游戏。' });
    startMatch(room);
  } else if (type === 'choose') {
    const choice = data.choice;
    if (room.status !== 'playing' || room.phase !== 'choose' || player.status !== 'active' || player.choice !== null) return;
    if (![1, 2, 3, 'bank'].includes(choice)) return;
    player.choice = choice;
    broadcast(room);
    resolveChoices(room);
  } else if (type === 'rematch') {
    if (room.status !== 'finished') return;
    player.rematchReady = true;
    if (room.players.length === 2 && room.players.every(p => p.rematchReady && isWebSocketOpen(p.ws))) startMatch(room);
    else broadcast(room);
  }
}

// A minimal RFC 6455 implementation for small masked browser text frames.
class Peer {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.closed = false;
    this.roomId = null; this.playerId = null; this.timestamps = [];
    socket.on('data', chunk => this.onData(chunk));
    socket.on('close', () => this.disconnected());
    socket.on('error', () => this.disconnected());
  }
  write(opcode, payload) {
    if (!isWebSocketOpen(this)) return;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let header;
    if (body.length <= 125) { header = Buffer.from([0x80 | opcode, body.length]); }
    else if (body.length <= 65535) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(body.length, 2); }
    else return;
    this.socket.write(Buffer.concat([header, body]));
  }
  send(value) { this.write(1, JSON.stringify(value)); }
  close() { if (this.closed) return; this.write(8, Buffer.alloc(0)); this.socket.end(); this.disconnected(); }
  disconnected() {
    if (this.closed) return; this.closed = true;
    const room = rooms.get(this.roomId);
    if (room) {
      const p = room.players.find(p => p.id === this.playerId);
      if (p && p.ws === this) { p.ws = null; broadcast(room); }
    }
  }
  onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 40000) return this.close();
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      if ((b0 & 0x80) === 0) return this.close(); // no continuation/fragmentation
      if (!(b1 & 0x80)) return this.close(); // browsers must mask their frames
      let pos = 2, len = b1 & 0x7f;
      if (len === 127) return this.close();
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); pos = 4; }
      if (len > 16000) return this.close();
      if (this.buffer.length < pos + 4 + len) return;
      const mask = this.buffer.subarray(pos, pos + 4); pos += 4;
      const payload = Buffer.from(this.buffer.subarray(pos, pos + len));
      this.buffer = this.buffer.subarray(pos + len);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 8) return this.close();
      if (opcode === 9) { this.write(10, payload); continue; }
      if (opcode === 10) continue;
      if (opcode !== 1) return this.close();
      let data;
      try { data = JSON.parse(payload.toString('utf8')); } catch { continue; }
      const now = Date.now();
      this.timestamps = this.timestamps.filter(ts => now - ts < 10000);
      if (this.timestamps.length >= 30) return this.close();
      this.timestamps.push(now);
      handleMessage(this, data);
    }
  }
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400); return res.end(); }
  if (pathname === '/') pathname = '/index.html';
  const abs = path.resolve(publicDir, '.' + pathname);
  if (!abs.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(data);
  });
});
server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws' || req.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '')) {
    socket.destroy(); return;
  }
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const peer = new Peer(socket);
  if (head.length) peer.onData(head);
});
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (now - room.lastActive > 1000 * 60 * 120 && room.players.every(p => !p.ws)) {
    clearTimer(room); rooms.delete(code);
  }
}, 1000 * 60 * 10).unref();
server.listen(PORT, '0.0.0.0', () => console.log(`EDGE CLUB listening on http://localhost:${PORT}`));
module.exports = { server, rooms };
