/**
 * Five Night's At 9A  -  Developer: dextomoser
 * Node.js + Express + Socket.io sunucusu (Render uyumlu)
 *
 * Akış:
 *  1) Akıllı tahta (host) 'host:create' ile bir oda (gameId) açar ve eşleşme jetonu (token) alır.
 *  2) Tahta, URL'si  /gamepad.html?game=<gameId>&token=<token>  olan bir QR kod gösterir.
 *  3) Telefon QR'ı okutur, 'controller:join' ile odaya katılır (gameId + token doğrulanır).
 *  4) Telefondan gelen 'cmd' olayları anlık olarak aynı odadaki tahtaya iletilir.
 */
'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const HOST_GRACE_MS = 2 * 60 * 1000;      // Tahta yenilenirse odayı 2 dk boyunca tut
const MAX_CMD_PER_SEC = 80;               // Soket başına komut sınırı

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e4,
  pingInterval: 10000,
  pingTimeout: 20000,
});

/* --------------------------- Statik dosyalar --------------------------- */
app.get('/healthz', (_req, res) => res.status(200).send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '1h' }));

/* ------------------------------ Oda yönetimi ---------------------------- */
/**
 * rooms: Map<gameId, {
 *   hostKey, token, hostSocketId, controllerSocketId, cleanupTimer, createdAt
 * }>
 */
const rooms = new Map();

const rand = (bytes) => crypto.randomBytes(bytes).toString('hex');

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''));
  const B = Buffer.from(String(b || ''));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function newRoom() {
  let gameId;
  do { gameId = rand(3).toUpperCase(); } while (rooms.has(gameId)); // 6 haneli kod
  const room = {
    hostKey: rand(16),
    token: rand(8),
    hostSocketId: null,
    controllerSocketId: null,
    cleanupTimer: null,
    createdAt: Date.now(),
  };
  rooms.set(gameId, room);
  return { gameId, room };
}

function scheduleCleanup(gameId) {
  const room = rooms.get(gameId);
  if (!room) return;
  clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const r = rooms.get(gameId);
    if (r && !r.hostSocketId) {
      if (r.controllerSocketId) io.to(r.controllerSocketId).emit('room:closed');
      rooms.delete(gameId);
    }
  }, HOST_GRACE_MS);
}

/* Telefonun gönderebileceği komutların beyaz listesi */
const BUTTON_CMDS = new Set([
  'sol_kapi', 'sag_kapi',          // action: 'toggle'
  'sol_isik', 'sag_isik',          // action: 'down' | 'up' | 'toggle'
  'kamera_toggle',                 // action: 'toggle'
  'ofis_sol', 'ofis_merkez', 'ofis_sag', // ofiste bakış yönü
  'menu_yeni', 'menu_devam',       // ana menü
  'imlec_tik',                     // sanal imleçle tıkla
]);
for (let i = 1; i <= 11; i++) BUTTON_CMDS.add('cam_' + i);

const ACTIONS = new Set(['toggle', 'down', 'up', 'tap']);

function sanitizeCmd(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const type = String(msg.type || '');
  if (type === 'imlec_hareket') {
    const dx = Number(msg.dx), dy = Number(msg.dy);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    return { type, dx: Math.max(-400, Math.min(400, dx)), dy: Math.max(-400, Math.min(400, dy)) };
  }
  if (!BUTTON_CMDS.has(type)) return null;
  const action = ACTIONS.has(msg.action) ? msg.action : 'tap';
  return { type, action };
}

/* ------------------------------- Soketler ------------------------------- */
io.on('connection', (socket) => {
  let role = null;
  let gameId = null;
  let cmdCount = 0;
  const rl = setInterval(() => { cmdCount = 0; }, 1000);

  /* ---- Tahta (host) ---- */
  socket.on('host:create', (payload, ack) => {
    if (typeof ack !== 'function') return;
    payload = payload || {};
    const existing = rooms.get(String(payload.gameId || '').toUpperCase());

    // Sayfa yenilendiyse aynı odayı gizli anahtarla geri al
    if (existing && safeEqual(existing.hostKey, payload.hostKey)) {
      const gid = String(payload.gameId).toUpperCase();
      clearTimeout(existing.cleanupTimer);
      existing.hostSocketId = socket.id;
      role = 'host'; gameId = gid;
      socket.join(gid);
      return ack({
        ok: true, resumed: true, gameId: gid, token: existing.token, hostKey: existing.hostKey,
        controllerConnected: !!existing.controllerSocketId,
      });
    }

    const { gameId: gid, room } = newRoom();
    room.hostSocketId = socket.id;
    role = 'host'; gameId = gid;
    socket.join(gid);
    ack({ ok: true, resumed: false, gameId: gid, token: room.token, hostKey: room.hostKey, controllerConnected: false });
  });

  /* ---- Telefon (gamepad) ---- */
  socket.on('controller:join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    payload = payload || {};
    const gid = String(payload.gameId || '').toUpperCase();
    const room = rooms.get(gid);
    if (!room) return ack({ ok: false, error: 'Oda bulunamadı. Tahtadaki QR kodu yeniden okutun.' });
    if (!safeEqual(room.token, payload.token)) return ack({ ok: false, error: 'Geçersiz eşleşme jetonu.' });
    if (!room.hostSocketId) return ack({ ok: false, error: 'Tahta şu an bağlı değil.' });

    // Eski kumandayı (varsa) düşür, yenisini al
    if (room.controllerSocketId && room.controllerSocketId !== socket.id) {
      io.to(room.controllerSocketId).emit('room:replaced');
      const old = io.sockets.sockets.get(room.controllerSocketId);
      if (old) old.leave(gid);
    }
    room.controllerSocketId = socket.id;
    role = 'controller'; gameId = gid;
    socket.join(gid);
    io.to(room.hostSocketId).emit('controller:connected');
    ack({ ok: true, gameId: gid });
  });

  /* ---- Telefondan gelen komutlar -> tahtaya ---- */
  socket.on('cmd', (msg) => {
    if (role !== 'controller' || !gameId) return;
    const room = rooms.get(gameId);
    if (!room || room.controllerSocketId !== socket.id || !room.hostSocketId) return;
    if (++cmdCount > MAX_CMD_PER_SEC) return;
    const clean = sanitizeCmd(msg);
    if (!clean) return;
    io.to(room.hostSocketId).emit('cmd', clean);
  });

  /* ---- Tahtadan telefona geri bildirim (isteğe bağlı) ---- */
  socket.on('host:status', (msg) => {
    if (role !== 'host' || !gameId) return;
    const room = rooms.get(gameId);
    if (room && room.controllerSocketId) {
      io.to(room.controllerSocketId).emit('status', { text: String((msg && msg.text) || '').slice(0, 80) });
    }
  });

  socket.on('disconnect', () => {
    clearInterval(rl);
    if (!gameId) return;
    const room = rooms.get(gameId);
    if (!room) return;
    if (role === 'host' && room.hostSocketId === socket.id) {
      room.hostSocketId = null;
      if (room.controllerSocketId) io.to(room.controllerSocketId).emit('host:disconnected');
      scheduleCleanup(gameId);
    } else if (role === 'controller' && room.controllerSocketId === socket.id) {
      room.controllerSocketId = null;
      if (room.hostSocketId) io.to(room.hostSocketId).emit('controller:disconnected');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Five Night's At 9A (dextomoser) ${PORT} portunda çalışıyor.`);
});
