require('dotenv').config();
const express  = require('express');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

// ===========================
// MIDDLEWARE
// ===========================
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ===========================
// CONFIG
// ===========================
const JWT_SECRET = process.env.JWT_SECRET || 'layarbiru_secret_key_2024';

const ADMIN_USER = {
  name:     process.env.ADMIN_NAME || 'Admin Layar Biru',
  initial:  'AL',
  role:     'admin',
  password: process.env.ADMIN_PASSWORD || 'Bayu.0905'
};

// ===========================
// GOOGLE DRIVE CONFIG
// ===========================
const GDRIVE_API_KEY   = process.env.GDRIVE_API_KEY   || 'AIzaSyB8MY-5lLPOirCFvXO8qEwHgY5zntv0m4c';
const GDRIVE_FOLDER_ID = process.env.GDRIVE_FOLDER_ID || '1RjxjqHRT6X9sU8rH87pfzz6hr-VlKet-';

// Cache film dari GDrive agar tidak hit API setiap request
let gdriveFilmsCache = [];
let gdriveCacheTime  = 0;
const GDRIVE_CACHE_TTL = 5 * 60 * 1000; // 5 menit

const GRADIENTS_POOL = [
  'linear-gradient(135deg,#1a1a2e,#16213e)',
  'linear-gradient(135deg,#0f3460,#533483)',
  'linear-gradient(135deg,#e94560,#0f3460)',
  'linear-gradient(135deg,#2c003e,#ad5cad)',
  'linear-gradient(135deg,#1b1b2f,#e43f5a)',
  'linear-gradient(135deg,#162447,#1f4068)',
  'linear-gradient(135deg,#1b262c,#0f4c75)',
  'linear-gradient(135deg,#2d132c,#ee4540)',
  'linear-gradient(135deg,#0d0d0d,#3a0ca3)',
  'linear-gradient(135deg,#10002b,#e0aaff)',
];

// Ambil daftar video dari Google Drive folder
async function fetchGDriveFilms() {
  const now = Date.now();
  if (gdriveFilmsCache.length > 0 && (now - gdriveCacheTime) < GDRIVE_CACHE_TTL) {
    return gdriveFilmsCache;
  }

  try {
    let allFiles  = [];
    let pageToken = '';

    // Pagination — ambil semua file tanpa batas 50
    do {
      const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const url = `https://www.googleapis.com/drive/v3/files?q='${GDRIVE_FOLDER_ID}'+in+parents+and+mimeType+contains+'video/'&fields=files(id,name,thumbnailLink,mimeType,size),nextPageToken&key=${GDRIVE_API_KEY}&pageSize=100${pageParam}`;

      const res  = await fetch(url);
      const data = await res.json();

      if (!res.ok || !data.files) {
        console.error('[GDRIVE] Error fetch halaman:', JSON.stringify(data));
        break; // pakai cache lama jika ada error di tengah pagination
      }

      allFiles  = allFiles.concat(data.files);
      pageToken = data.nextPageToken || '';
      console.log(`[GDRIVE] Halaman selesai — total sementara: ${allFiles.length} file`);

    } while (pageToken);

    if (allFiles.length === 0) {
      console.warn('[GDRIVE] Tidak ada file ditemukan, return cache lama');
      return gdriveFilmsCache;
    }

    const films = allFiles.map((file, index) => {
      // Bersihkan nama file dari ekstensi
      const title    = file.name.replace(/\.[^/.]+$/, '');
      const fileId   = file.id;
      const mimeType = file.mimeType || 'video/mp4';

      // URL embed GDrive (diputar di iframe)
      const embed = `https://drive.google.com/file/d/${fileId}/preview`;

      // URL direct stream (untuk <video> tag — butuh cors / redirect)
      const streamUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

      // Thumbnail dari GDrive jika ada, fallback ke placeholder
      const thumb = file.thumbnailLink
        ? file.thumbnailLink.replace('=s220', '=s480')
        : `https://drive.google.com/thumbnail?id=${fileId}&sz=w480`;

      return {
        id:        index + 1,
        fileId,
        title,
        desc:      'Google Drive',
        videoId:   fileId,
        thumb,
        embed,          // URL preview GDrive (untuk iframe fallback)
        streamUrl,      // URL untuk diunduh/streaming langsung
        mimeType,
        gradient:  GRADIENTS_POOL[index % GRADIENTS_POOL.length],
        duration:  '—',
        source:    'gdrive'
      };
    });

    gdriveFilmsCache = films;
    gdriveCacheTime  = now;
    console.log(`[GDRIVE] ${films.length} video ditemukan di folder (pagination selesai)`);
    return films;

  } catch (err) {
    console.error('[GDRIVE] Fetch error:', err.message);
    return gdriveFilmsCache;
  }
}

// ===========================
// SESSION STORE
// ===========================
const activeSessions = new Map();
const sseClients     = new Set();
const userSessions   = new Map();

// ===========================
// REFRESH GRACE PERIOD
// Saat viewer disconnect (socket putus), tunggu dulu sebelum
// benar-benar dianggap keluar. Jika reconnect dalam waktu
// REFRESH_GRACE_MS → anggap refresh, jangan log KELUAR.
// ===========================
// Railway/cloud hosting sering punya transport timeout 5-7 detik
// Naikkan ke 8 detik agar refresh di koneksi lambat tetap tercover
const REFRESH_GRACE_MS = 8000; // 8 detik grace period
const pendingDisconnects = new Map(); // sessionId → { timer, user }

// ===========================
// ADMIN RECONNECT TRACKING
// Karena setiap reconnect = socket baru, socket._wasAdmin selalu false.
// Solusi: pakai timestamp — jika admin reconnect dalam 15 detik = isReconnect true.
// ===========================
let adminLastConnectedAt  = 0;
let adminLastDisconnectAt = 0;
const ADMIN_RECONNECT_WINDOW_MS = 15000; // 15 detik

// ===========================
// ADMIN ACTIVITY LOG
// ===========================
const MAX_LOGS = 200;
let serverLogs = [];

function addServerLog(user, action, color = '#5B8CFF', type = '') {
  const now = new Date();
  const entry = {
    id:        now.getTime() + '-' + Math.random().toString(36).slice(2, 7),
    user,
    action,
    color,
    type,
    time:      now.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Asia/Makassar' }),
    date:      now.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric', timeZone:'Asia/Makassar' }),
    timestamp: now.getTime()
  };
  serverLogs.unshift(entry);
  if (serverLogs.length > MAX_LOGS) serverLogs.length = MAX_LOGS;

  const payload = JSON.stringify({ type: 'log', data: entry });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
  return entry;
}

function broadcastSessions() {
  const payload = JSON.stringify({ type:'sessions', data: getSessionsPayload() });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}

// ===========================
// TELEGRAM BOT NOTIFICATION
// ===========================
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7039626075';

async function sendTelegramNotif(message) {
  if (!TELEGRAM_TOKEN) {
    console.warn('[TELEGRAM] TELEGRAM_TOKEN tidak diset di environment variable, notifikasi dilewati.');
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
    if (!data.ok) console.error('[TELEGRAM] Gagal kirim:', data.description);
  } catch (err) {
    console.error('[TELEGRAM] Error:', err.message);
  }
}

function broadcastNewLogin(user) {
  const payload = JSON.stringify({
    type: 'new-login',
    data: {
      name:    user.name,
      initial: user.initial,
      role:    user.role,
      time:    Date.now()
    }
  });
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`); } catch {}
  }
}

function getSessionsPayload() {
  const now = Date.now();
  return Array.from(activeSessions.values()).map(s => ({
    id:        s.id,
    name:      s.user.name,
    initial:   s.user.initial,
    email:     s.user.name,
    film:      s.film,
    camActive: s.camActive,
    micActive: s.micActive,
    duration:  Math.floor((now - s.startTime) / 1000),
    startTime: s.startTime
  }));
}

function generateInitial(fullName) {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].substring(0, 1).toUpperCase();
  return (parts[0].substring(0, 1) + parts[1].substring(0, 1)).toUpperCase();
}

// ===========================
// SOCKET.IO — WebRTC SIGNALING
// ===========================
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  // Lag Fix 4: Utamakan WebSocket, bukan polling.
  // Default ['polling','websocket'] berarti setiap koneksi mulai dari HTTP polling dulu
  // → sinyal WebRTC (offer/answer/ICE) terkirim lambat → stream terlambat nyambung.
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout:  20000,
  upgradeTimeout: 10000,
  allowEIO3: true
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(new Error('Unauthorized'));
  try {
    socket._user = jwt.verify(token, JWT_SECRET);
    socket._role = socket._user.role;
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  const user = socket._user;
  const role = socket._role;

  if (role === 'viewer') {
    socket.on('register-viewer', ({ sessionId }) => {
      socket._sessionId = sessionId;
      socket.join(`viewer:${sessionId}`);

      // ── Batalkan grace period jika viewer reconnect (refresh) ──
      // Jika ada pending disconnect untuk sessionId ini, berarti ini
      // adalah viewer yang baru saja refresh — cancel timer KELUAR-nya.
      const pending = pendingDisconnects.get(sessionId);
      if (pending) {
        clearTimeout(pending.timer);
        pendingDisconnects.delete(sessionId);
        console.log(`[SIO] Grace period dibatalkan — viewer reconnect: ${user.name} (${sessionId})`);
        // Tidak perlu emit viewer-connected lagi ke admin karena card masih ada
        // Cukup update info via SSE broadcastSessions yang sudah berjalan periodik
        addServerLog(user.name, 'terhubung kembali setelah refresh', '#4ADE80', 'connect');
        return; // skip tryEmitConnected karena admin sudah punya card-nya
      }

      // Validasi: sessionId harus cocok dengan activeSessions
      // Kalau viewer konek sebelum /api/session/start selesai, coba tunggu sebentar
      // FIX: guard agar tryEmitConnected tidak fire lebih dari sekali
      // (mencegah log "Viewer terhubung" duplikat dari retry loop)
      let _emitConnectedDone = false;

      const tryEmitConnected = (attempt) => {
        if (_emitConnectedDone) return; // sudah berhasil, stop retry
        if (!socket.connected) return;  // socket sudah putus, stop retry

        let sessionFound = false;
        for (const [, s] of activeSessions) {
          if (s.id === sessionId) { sessionFound = true; break; }
          // Fallback: cocokkan berdasarkan nama user jika sessionId belum ada
          if (s.user && s.user.name === user.name) {
            socket._sessionId = s.id;
            sessionFound = true;
            console.log(`[SIO] sessionId remapped ${sessionId} → ${s.id} untuk ${user.name}`);
            break;
          }
        }

        if (sessionFound || attempt >= 8) {
          _emitConnectedDone = true; // tandai sudah selesai — stop semua retry berikutnya
          const finalSessionId = socket._sessionId;
          io.to('admins').emit('viewer-connected', { sessionId: finalSessionId, user });
          console.log(`[SIO] Viewer terhubung: ${user.name} (${finalSessionId}) attempt=${attempt}`);
        } else {
          console.warn(`[SIO] SessionId ${sessionId} belum ada, retry ${attempt}/8`);
          setTimeout(() => tryEmitConnected(attempt + 1), 400);
        }
      };
      tryEmitConnected(1);

      addServerLog(user.name, 'terhubung ke dashboard streaming', '#4ADE80', 'connect');
    });

    socket.on('answer', (msg) => { io.to('admins').emit('answer', msg); });
    socket.on('ice-candidate', (msg) => { io.to('admins').emit('ice-candidate', { ...msg, from: 'viewer' }); });
    // FIX #1 & #5: Handle film-selected — update activeSessions.film agar dashboard admin akurat
    socket.on('film-selected', ({ film, sessionId: sid }) => {
      const targetId = sid || socket._sessionId;
      if (!targetId) return;
      for (const [, s] of activeSessions) {
        if (s.id === targetId) {
          s.film = film || s.film;
          break;
        }
      }
      broadcastSessions();
      io.to('admins').emit('film-selected', { sessionId: targetId, film });
    });

    socket.on('flip-camera-accepted', ({ sessionId }) => {
      if (!sessionId) return;
      io.to('admins').emit('flip-camera-accepted', { sessionId });
    });
    socket.on('flip-camera-rejected', ({ sessionId }) => {
      if (!sessionId) return;
      io.to('admins').emit('flip-camera-rejected', { sessionId });
    });
    socket.on('disconnect', (reason) => {
      if (!socket._sessionId) return;
      const sessionId = socket._sessionId;

      // ── GRACE PERIOD untuk bedakan REFRESH vs KELUAR beneran ──
      // Saat viewer refresh browser, socket putus lalu reconnect lagi
      // dalam ~1-3 detik. Kalau langsung emit viewer-disconnected,
      // admin melihat KELUAR padahal viewer cuma refresh.
      //
      // Solusi: tunda emit viewer-disconnected selama REFRESH_GRACE_MS.
      // Jika viewer reconnect sebelum timer habis → cancel timer → tidak ada log KELUAR.
      // Jika tidak reconnect → timer habis → baru dianggap benar-benar keluar.

      // Batalkan grace period sebelumnya untuk session ini jika ada
      const existing = pendingDisconnects.get(sessionId);
      if (existing) { clearTimeout(existing.timer); }

      const timer = setTimeout(() => {
        pendingDisconnects.delete(sessionId);
        // Cek apakah viewer sudah reconnect (ada socket lain dengan sessionId yang sama)
        let reconnected = false;
        io.sockets.sockets.forEach(s => {
          if (s._role === 'viewer' && s._sessionId === sessionId && s.id !== socket.id) {
            reconnected = true;
          }
        });
        if (!reconnected) {
          io.to('admins').emit('viewer-disconnected', { sessionId });
          addServerLog(user.name, 'memutus koneksi streaming', '#F2716B', 'disconnect');
          console.log(`[SIO] Viewer benar-benar keluar: ${user.name} (${sessionId})`);
        } else {
          console.log(`[SIO] Viewer refresh terdeteksi, skip KELUAR log: ${user.name}`);
        }
      }, REFRESH_GRACE_MS);

      pendingDisconnects.set(sessionId, { timer, user });
      console.log(`[SIO] Viewer disconnect (grace period ${REFRESH_GRACE_MS}ms): ${user.name} reason=${reason}`);
    });
  }

  if (role === 'admin') {
    socket.join('admins');
    socket.on('register-admin', () => {
      // FIX: Gunakan timestamp untuk deteksi reconnect, bukan per-socket flag.
      // Karena setiap reconnect = socket BARU di server, socket._wasAdmin selalu false.
      // Jika admin reconnect dalam ADMIN_RECONNECT_WINDOW_MS → isReconnect = true.
      const now = Date.now();
      const isReconnect = (now - adminLastDisconnectAt) < ADMIN_RECONNECT_WINDOW_MS;
      adminLastConnectedAt = now;

      const viewers = [];
      io.sockets.sockets.forEach(s => {
        if (s._role === 'viewer' && s._sessionId) {
          viewers.push({ sessionId: s._sessionId, user: s._user });
        }
      });

      // Kirim flag isReconnect ke client — jika true, client TIDAK reset WebRTC
      // yang sudah connected, cukup sync card UI saja agar stream tidak hitam
      socket.emit('viewer-list', { viewers, isReconnect });

      if (isReconnect) {
        addServerLog('Admin', 'terhubung kembali ke dashboard streaming', '#4ADE80', 'connect');
      } else {
        addServerLog('Admin', 'terhubung ke dashboard streaming', '#4ADE80', 'connect');
      }
      console.log(`[SIO] Admin ${isReconnect ? 'reconnect' : 'baru'}: ${user.name} (gap=${now - adminLastDisconnectAt}ms)`);
    });

    // Keep-alive ping dari client admin — no-op, hanya untuk cegah socket timeout
    socket.on('ping-admin', () => { /* keep-alive */ });

    socket.on('offer', ({ sessionId, data }) => { io.to(`viewer:${sessionId}`).emit('offer', { sessionId, data }); });
    socket.on('ice-candidate', (msg) => { io.to(`viewer:${msg.sessionId}`).emit('ice-candidate', { ...msg, from: 'admin' }); });
    socket.on('flip-camera', ({ sessionId }) => {
      if (!sessionId) return;
      const targetRoom = io.sockets.adapter.rooms.get(`viewer:${sessionId}`);
      if (!targetRoom || targetRoom.size === 0) {
        socket.emit('flip-camera-rejected', { sessionId }); return;
      }
      io.to(`viewer:${sessionId}`).emit('flip-camera');
    });
    socket.on('kick-viewer', ({ sessionId }) => {
      if (!sessionId) return;
      io.to(`viewer:${sessionId}`).emit('kicked');
      // Bug 3 fix: hapus sesi dari activeSessions dan broadcast ke admin
      activeSessions.forEach((s, t) => { if (s.id === sessionId) activeSessions.delete(t); });
      broadcastSessions();
      addServerLog('Admin', `kick paksa (socket): sesi ${sessionId}`, '#F2716B', 'error');
    });
    socket.on('disconnect', () => {
      adminLastDisconnectAt = Date.now(); // simpan waktu putus untuk deteksi reconnect
      console.log(`[SIO] Admin putus: ${user.name}`);
    });
  }
});

// ===========================
// HTTP ROUTES
// ===========================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    viewers: [...io.sockets.sockets.values()].filter(s => s._role === 'viewer').length,
    admins:  [...io.sockets.sockets.values()].filter(s => s._role === 'admin').length
  });
});

app.post('/api/check-admin', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, isAdmin: false, message: 'Nama wajib diisi.' });
  const isAdmin = name.trim().toLowerCase() === 'admin';
  res.json({ success: true, isAdmin, message: isAdmin ? 'Admin terdeteksi' : 'Bukan admin' });
});

app.post('/api/login', async (req, res) => {
  const { name, password } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, code: 'MISSING_NAME', message: 'Nama wajib diisi.' });

  const trimmedName      = name.trim();
  const trimmedNameLower = trimmedName.toLowerCase();

  if (trimmedNameLower === 'admin') {
    if (!password) return res.status(401).json({ success: false, code: 'PASSWORD_REQUIRED', message: 'Password admin wajib diisi.' });
    if (password !== ADMIN_USER.password) {
      addServerLog('Sistem', 'Login admin gagal — password salah', '#F2716B', 'error');
      return res.status(401).json({ success: false, code: 'WRONG_PASSWORD', message: 'Password admin salah.' });
    }
    const token = jwt.sign({ name: 'Admin', initial: 'YZ', role: 'admin' }, JWT_SECRET, { expiresIn: '8h' });
    addServerLog('Admin', 'login sebagai admin', '#5B8CFF', 'login');
    return res.json({ success: true, token, user: { name: 'Admin', initial: 'YZ', role: 'admin' } });
  }

  const initial = generateInitial(trimmedName);
  for (const [oldToken, s] of activeSessions) {
    // FIX Bug 5: field yang benar adalah s.user.name, bukan s.name
    // Sebelumnya sesi lama tidak pernah dihapus → pengguna sama bisa punya 2 sesi aktif
    if (s.user && s.user.name.toLowerCase() === trimmedNameLower) activeSessions.delete(oldToken);
  }

  const token = jwt.sign({ name: trimmedName, initial, role: 'viewer' }, JWT_SECRET, { expiresIn: '8h' });
  addServerLog(trimmedName, 'baru saja masuk ke platform', '#4ADE80', 'connect');
  broadcastNewLogin({ name: trimmedName, initial, role: 'viewer' });

  // FIX: totalSesi dihitung SETELAH sesi ditambahkan di /api/session/start,
  // tapi karena login dan session/start terpisah, kita hitung activeSessions.size + 1
  // sebagai estimasi (pengguna ini belum terdaftar di activeSessions saat login).
  // Notifikasi di-await agar error tidak diam-diam terlewat.
  const waktu     = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Makassar' });
  const totalSesi = activeSessions.size + 1; // +1 karena pengguna ini belum masuk activeSessions
  sendTelegramNotif(
`🟢 <b>Pengguna Baru Masuk</b>\n\n👤 <b>Nama</b>    : ${trimmedName}\n🕐 <b>Waktu</b>   : ${waktu} WITA\n📊 <b>Sesi aktif</b>: ${totalSesi} pengguna\n\n— <i>Layar Biru Dashboard</i>`
  ).catch(e => console.error('[TELEGRAM] Login notif gagal:', e.message));

  res.json({ success: true, token, user: { name: trimmedName, initial, role: 'viewer' } });
});

app.get('/api/verify', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try { res.json({ success:true, user: jwt.verify(token, JWT_SECRET) }); }
  catch { res.status(401).json({ success:false }); }
});

app.post('/api/session/start', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const user = jwt.verify(token, JWT_SECRET);
    activeSessions.set(token, {
      id:        token.slice(-8),
      user,
      startTime: Date.now(),
      film:      req.body.film || '—',
      camActive: req.body.camActive !== false,
      micActive: req.body.micActive !== false,
      lastPing:  Date.now()
    });
    broadcastSessions();
    res.json({ success:true, sessionId: token.slice(-8) });
  } catch { res.status(401).json({ success:false }); }
});

app.post('/api/session/ping', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  const s = activeSessions.get(token);
  if (s) {
    s.lastPing  = Date.now();
    // Lag Fix 5: Hanya broadcast jika ada perubahan data penting (film/cam/mic),
    // bukan setiap ping heartbeat. Sebelumnya broadcastSessions() dipanggil tiap 5 detik
    // per viewer → dengan 10 viewer = 2 SSE broadcast/detik ke semua admin client → beban server naik.
    const filmChanged = req.body.film      != null && req.body.film      !== s.film;
    const camChanged  = req.body.camActive != null && req.body.camActive !== s.camActive;
    const micChanged  = req.body.micActive != null && req.body.micActive !== s.micActive;
    s.film      = req.body.film      ?? s.film;
    s.camActive = req.body.camActive ?? s.camActive;
    s.micActive = req.body.micActive ?? s.micActive;
    if (filmChanged || camChanged || micChanged) broadcastSessions();
  }
  res.json({ success:true });
});

app.post('/api/logout', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (token) {
    try {
      const d    = jwt.verify(token, JWT_SECRET);
      const sesi = activeSessions.get(token);

      // ── Cek apakah ini logout beneran atau logout dari refresh ──
      // Saat viewer refresh, beforeunload lama mungkin masih trigger
      // sendBeacon logout sebelum fix diterapkan, atau ada edge case lain.
      // Jika socket viewer dengan sessionId yang sama masih aktif
      // (sudah reconnect), jangan hapus sesinya.
      if (sesi) {
        const sessionId = sesi.id;
        let socketStillAlive = false;
        io.sockets.sockets.forEach(s => {
          if (s._role === 'viewer' && s._sessionId === sessionId) {
            socketStillAlive = true;
          }
        });
        if (socketStillAlive) {
          // Viewer sudah reconnect — ini kemungkinan beacon dari refresh lama, abaikan
          console.log(`[LOGOUT] Diabaikan — viewer ${d.name} masih terhubung via socket`);
          return res.json({ success: true });
        }
      }

      const dur  = sesi ? Math.floor((Date.now() - sesi.startTime) / 60000) : 0;
      activeSessions.delete(token);
      broadcastSessions();
      addServerLog(d.name, 'logout / mengakhiri sesi', '#F2A93B', 'logout');
      if (d.role === 'viewer') {
        const waktu = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Makassar' });
        sendTelegramNotif(
`🔴 <b>Pengguna Keluar</b>\n\n👤 <b>Nama</b>    : ${d.name}\n🕐 <b>Waktu</b>   : ${waktu} WITA\n⏱ <b>Durasi</b>  : ${dur} menit\n\n— <i>Layar Biru Dashboard</i>`
        );
      }
    } catch {}
  }
  res.json({ success:true });
});

app.get('/api/sessions', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'admin') return res.status(403).json({ success:false });
    res.json({ success:true, sessions: getSessionsPayload() });
  } catch { res.status(401).json({ success:false }); }
});

app.get('/api/logs', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'admin') return res.status(403).json({ success:false });
    res.json({ success:true, logs: serverLogs });
  } catch { res.status(401).json({ success:false }); }
});

app.delete('/api/logs', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'admin') return res.status(403).json({ success:false });
    serverLogs = [];
    res.json({ success:true });
  } catch { res.status(401).json({ success:false }); }
});

app.post('/api/kick', (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'admin') return res.status(403).json({ success:false });
    const { sessionId, name } = req.body;
    if (!sessionId) return res.status(400).json({ success:false, message:'sessionId wajib diisi' });
    io.to(`viewer:${sessionId}`).emit('kicked');
    activeSessions.forEach((s, t) => { if (s.id === sessionId) { activeSessions.delete(t); } });
    broadcastSessions();
    addServerLog('Admin', `kick paksa: ${name || sessionId}`, '#F2716B', 'error');
    sendTelegramNotif(`🚫 <b>Pengguna Di-Kick</b>\n\n👤 <b>Nama</b>: ${name || sessionId}\n— <i>Layar Biru Dashboard</i>`);
    res.json({ success:true });
  } catch { res.status(401).json({ success:false }); }
});

app.get('/api/sessions/stream', (req, res) => {
  try { jwt.verify(req.query.token, JWT_SECRET); } catch { return res.status(401).end(); }
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type:'sessions', data: getSessionsPayload() })}\n\n`);
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(`: ping\n\n`); } catch {} }, 20000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ================================================================
// FILMS — Google Drive API
// ================================================================

// GET /api/films — ambil film dari Google Drive folder
app.get('/api/films', async (req, res) => {
  try {
    const films = await fetchGDriveFilms();
    res.json({ success: true, films, source: 'gdrive' });
  } catch (err) {
    console.error('[FILMS] GET error:', err.message);
    res.json({ success: true, films: [], source: 'gdrive' });
  }
});

// POST /api/films/refresh — paksa refresh cache GDrive (admin only)
app.post('/api/films/refresh', async (req, res) => {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ success:false });
  try {
    const u = jwt.verify(token, JWT_SECRET);
    if (u.role !== 'admin') return res.status(403).json({ success:false });
    gdriveFilmsCache = [];
    gdriveCacheTime  = 0;
    const films = await fetchGDriveFilms();
    res.json({ success: true, films, count: films.length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Cleanup sesi timeout
// OPTIMASI JARINGAN: Naikkan timeout dari 30s ke 45s karena ping client sekarang 15s.
// Sebelumnya ping 5s → timeout 30s (6x ping). Sekarang ping 15s → timeout 45s (3x ping).
// Margin 3 ping cukup toleran terhadap jaringan fluktuatif tanpa mengorbankan deteksi offline.
setInterval(() => {
  const now = Date.now(); let changed = false;
  for (const [token, s] of activeSessions) {
    if (now - s.lastPing > 45000) { activeSessions.delete(token); changed = true; }
  }
  if (changed) broadcastSessions();
}, 10000);

// Lag Fix 5 (lanjutan): Broadcast sesi setiap 15 detik agar durasi di dashboard admin
// tetap terupdate, tanpa harus bergantung pada ping setiap viewer.
setInterval(() => {
  if (activeSessions.size > 0 && sseClients.size > 0) broadcastSessions();
}, 15000);

// ================================================================
// PROXY VIDEO — stream video GDrive lewat server (bypass CORS)
// GET /api/proxy-video?id=FILE_ID
// Mendukung Range requests sehingga seek/skip video berfungsi
// ================================================================

// Cache URL direct download per fileId (valid ~1 jam)
const proxyUrlCache = new Map(); // fileId → { url, expires }

async function resolveGDriveDirectUrl(fileId) {
  // Cek cache dulu
  const cached = proxyUrlCache.get(fileId);
  if (cached && Date.now() < cached.expires) return cached.url;

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    'Accept': '*/*',
  };

  // Step 1: Coba URL export download langsung
  let url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

  // Ikuti redirect manual (maksimal 5 kali) untuk dapat URL final
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: baseHeaders, redirect: 'manual' });

    if (r.status === 200) {
      const ct = r.headers.get('content-type') || '';
      if (ct.startsWith('video/') || ct.startsWith('application/octet') || ct === 'binary/octet-stream') {
        // Ini sudah URL file video langsung
        proxyUrlCache.set(fileId, { url, expires: Date.now() + 45 * 60 * 1000 });
        return url;
      }
      // Mungkin HTML konfirmasi — cari confirm token dari body
      const html = await r.text();
      const match = html.match(/confirm=([0-9A-Za-z_\-]+)/);
      if (match) {
        url = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${match[1]}`;
        continue;
      }
      // Coba URL alternatif via drive.usercontent.google.com
      url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
      continue;
    }

    if (r.status === 302 || r.status === 301 || r.status === 307 || r.status === 308) {
      const location = r.headers.get('location');
      if (!location) break;
      url = location;
      continue;
    }

    break;
  }

  // Fallback: coba drive.usercontent.google.com
  url = `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`;
  proxyUrlCache.set(fileId, { url, expires: Date.now() + 15 * 60 * 1000 });
  return url;
}

app.get('/api/proxy-video', async (req, res) => {
  const fileId = req.query.id;
  if (!fileId) return res.status(400).json({ error: 'Parameter id wajib diisi' });

  // BUG FIX #6 (Black Screen): Tambahkan retry loop di level proxy.
  // GDrive sering kembalikan HTML konfirmasi (bukan video) untuk file besar.
  // Sebelumnya langsung 502 → client dapat error → layar hitam.
  // Sekarang: invalidate cache + resolve ulang URL maksimal 2 kali sebelum menyerah.
  const MAX_PROXY_RETRY = 2;

  for (let attempt = 0; attempt <= MAX_PROXY_RETRY; attempt++) {
    try {
      if (attempt > 0) {
        // Invalidate cache dulu agar resolveGDriveDirectUrl ambil URL segar
        proxyUrlCache.delete(fileId);
        console.warn(`[PROXY] Retry ${attempt}/${MAX_PROXY_RETRY} untuk fileId=${fileId}`);
      }

      const directUrl = await resolveGDriveDirectUrl(fileId);

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        'Accept': '*/*',
      };

      // Teruskan Range header dari browser (untuk seek/skip)
      if (req.headers['range']) {
        headers['Range'] = req.headers['range'];
      }

      const upstream = await fetch(directUrl, { headers, redirect: 'follow' });

      if (!upstream.ok && upstream.status !== 206) {
        proxyUrlCache.delete(fileId);
        console.error(`[PROXY] Upstream error ${upstream.status} id=${fileId} attempt=${attempt}`);
        if (attempt < MAX_PROXY_RETRY) continue; // retry
        return res.status(502).json({ error: 'Video tidak dapat dimuat dari GDrive' });
      }

      // Cek apakah response adalah HTML (bukan video) — artinya dapat halaman konfirmasi GDrive
      const ct = upstream.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        proxyUrlCache.delete(fileId);
        console.warn(`[PROXY] GDrive kembalikan HTML id=${fileId} attempt=${attempt} — ${attempt < MAX_PROXY_RETRY ? 'retry' : 'gagal'}`);
        if (attempt < MAX_PROXY_RETRY) {
          // Buang body HTML agar koneksi bersih sebelum retry
          await upstream.body?.cancel().catch(() => {});
          continue; // retry dengan URL baru
        }
        return res.status(502).json({ error: 'GDrive mengembalikan halaman HTML, bukan video' });
      }

      // URL valid — stream ke client
      res.setHeader('Content-Type',  ct || 'video/mp4');
      res.setHeader('Accept-Ranges', upstream.headers.get('accept-ranges') || 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Access-Control-Allow-Origin', '*');

      const contentLength = upstream.headers.get('content-length');
      const contentRange  = upstream.headers.get('content-range');
      if (contentLength) res.setHeader('Content-Length', contentLength);
      if (contentRange)  res.setHeader('Content-Range',  contentRange);

      res.status(contentRange ? 206 : 200);

      // Stream pipe dengan backpressure
      const reader = upstream.body.getReader();
      let cancelled = false;

      req.on('close', () => {
        cancelled = true;
        reader.cancel().catch(() => {});
      });

      await (async () => {
        try {
          while (!cancelled) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            const ok = res.write(value);
            if (!ok) await new Promise(r => res.once('drain', r));
          }
        } catch (e) {
          if (!cancelled) console.error('[PROXY] Stream err:', e.message);
        }
      })();

      return; // sukses — keluar dari retry loop

    } catch (err) {
      proxyUrlCache.delete(fileId);
      console.error(`[PROXY] Error attempt=${attempt}:`, err.message);
      if (attempt >= MAX_PROXY_RETRY) {
        if (!res.headersSent) res.status(500).json({ error: 'Server gagal fetch video' });
        return;
      }
      // Lanjut retry
    }
  }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ===========================
// START
// ===========================
server.listen(PORT, () => {
  console.log(`\n🎬 Layar Biru v2.1 berjalan di port ${PORT}`);
  console.log(`📡 Socket.IO signaling aktif`);
  console.log(`☁️  Google Drive Folder: ${GDRIVE_FOLDER_ID}`);
  console.log(`🔑 GDrive API Key: ${GDRIVE_API_KEY.slice(0,8)}...`);
  console.log('');
  // Pre-load film dari GDrive saat startup
  fetchGDriveFilms().then(f => console.log(`[GDRIVE] ${f.length} film di-cache saat startup`));
});

function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Menutup server...`);
  io.emit('server-restart', { message: 'Server sedang restart.' });
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 8000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
