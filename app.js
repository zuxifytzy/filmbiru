// ================================================================
// LAYAR BIRU — app.js (Google Drive Video Player)
// ================================================================


// ================================================================
// FILMS — fallback array, diisi dari /api/films (Google Drive)
// ================================================================
const FILMS = [];

// ================================================================
// CONFIG
// ================================================================
const API_BASE = (
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
) ? 'http://localhost:3000' : '';

// TURN servers — ExpressTURN (kredensial pribadi)
const TURN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:free.expressturn.com:3478',               username: '000000002099123036', credential: 'mLhN+5+xpLZ66vPq8W0V0X2uMqU=' },
  { urls: 'turn:free.expressturn.com:3478?transport=tcp', username: '000000002099123036', credential: 'mLhN+5+xpLZ66vPq8W0V0X2uMqU=' }
];

// ================================================================
// STATE
// ================================================================
let currentUser           = null;
let camStream             = null;
let sessionStart          = null;
let sessionTimerInterval  = null;
let vidProgressInterval   = null;
let pingInterval          = null;

// ================================================================
// COOKIE HELPERS
// ================================================================
function setCookie(name, value, hours) {
  const exp = new Date(Date.now() + hours * 3600 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${exp};path=/;SameSite=Lax`;
}
function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function deleteCookie(name) {
  document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
}

let authToken    = getCookie('lb_token') || sessionStorage.getItem('lb_token') || null;
let isLoggingIn  = false;
let adminLogs    = [];
let mySessionId  = null;
let socket       = null;
let sseConnection = null;
let CURRENT_FILM = FILMS[0]?.title || '—';

let videoInputDevices   = [];
let currentDeviceIndex  = 0;
let currentFacingMode   = 'environment';
let isFlipping          = false;

const viewerPeers     = new Map();
const adminPeers      = new Map();
const adminAudioMeters = new Map();
let currentExpandedSession = null;


// ================================================================
// NAVIGATION
// ================================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function resetLogin() {
  isLoggingIn = false;
  document.getElementById('login-name').value            = '';
  document.getElementById('login-pass').value            = '';
  document.getElementById('chk-consent').checked         = false;
  document.getElementById('btn-login').disabled          = true;
  document.getElementById('login-error').classList.remove('show');
  document.getElementById('login-name').classList.remove('input-error');
  document.getElementById('login-pass').classList.remove('input-error');
  document.getElementById('password-section').style.display = 'none';
  document.getElementById('admin-detected').style.display   = 'none';
  document.getElementById('btn-text').textContent = 'Masuk & Mulai Nonton';
  const btnEl = document.getElementById('btn-login');
  if (btnEl) btnEl.dataset.mode = 'check';
}

function showLoginError(msg, ...els) {
  const el = document.getElementById('login-error');
  document.getElementById('login-error-text').textContent = msg;
  el.classList.add('show');
  els.forEach(e => e && e.classList.add('input-error'));
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ================================================================
// LOGIN
// ================================================================
async function checkAndLogin() {
  const nameEl        = document.getElementById('login-name');
  const passEl        = document.getElementById('login-pass');
  const passSection   = document.getElementById('password-section');
  const adminDetected = document.getElementById('admin-detected');
  const btnEl         = document.getElementById('btn-login');
  const name          = nameEl.value.trim();

  nameEl.classList.remove('input-error');
  passEl.classList.remove('input-error');
  document.getElementById('login-error').classList.remove('show');

  if (!name) { showLoginError('Nama wajib diisi.', nameEl); return; }

  try {
    const response = await fetch(`${API_BASE}/api/check-admin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
    });
    const data = await response.json();

    if (data.isAdmin) {
      passSection.style.display   = 'block';
      adminDetected.style.display = 'block';
      passEl.focus();
      document.getElementById('btn-text').textContent = 'Verifikasi Password & Masuk';
      btnEl.dataset.mode      = 'login';
      btnEl.dataset.adminName = name;
      return;
    } else {
      doLogin(name, null);
    }
  } catch (err) {
    showLoginError('Gagal cek admin. Silakan coba lagi.', nameEl);
  }
}

async function doLogin(name, password) {
  if (isLoggingIn) return;
  isLoggingIn = true;

  const nameEl    = document.getElementById('login-name');
  const passEl    = document.getElementById('login-pass');
  const btnEl     = document.getElementById('btn-login');
  const loginCard = document.querySelector('.login-card');
  const finalName = name || nameEl.value.trim();
  const finalPass = password !== undefined ? password : (passEl ? passEl.value : null) || null;

  nameEl.classList.remove('input-error');
  if (passEl) passEl.classList.remove('input-error');
  document.getElementById('login-error').classList.remove('show');

  if (!finalName) { showLoginError('Nama wajib diisi.', nameEl); return; }

  const passSection = document.getElementById('password-section');
  if (passSection.style.display !== 'none' && !finalPass) {
    showLoginError('Password wajib diisi.', passEl); return;
  }

  btnEl.disabled = true;
  btnEl.classList.add('loading');
  const btnText      = document.getElementById('btn-text') || btnEl;
  const originalText = btnText.textContent;
  btnText.textContent = 'Memverifikasi...';

  try {
    const response = await fetch(`${API_BASE}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: finalName, password: finalPass })
    });
    const data = await response.json();

    btnEl.classList.remove('loading');
    btnText.textContent = originalText;

    if (!response.ok || !data.success) {
      loginCard.classList.add('shake');
      setTimeout(() => loginCard.classList.remove('shake'), 450);
      if (data.code === 'PASSWORD_REQUIRED') showLoginError('Password wajib diisi.', passEl);
      else if (data.code === 'WRONG_PASSWORD') { document.getElementById('login-pass').value = ''; showLoginError('Password admin salah.', passEl); }
      else if (data.code === 'MISSING_NAME')   showLoginError(data.message, nameEl);
      else                                     showLoginError(data.message || 'Terjadi kesalahan.', nameEl);
      btnEl.disabled = !document.getElementById('chk-consent').checked;
      isLoggingIn = false;
      return;
    }

    authToken   = data.token;
    currentUser = data.user;
    setCookie('lb_token', authToken, 8); sessionStorage.setItem('lb_token', authToken);
    isLoggingIn = false;

    if (currentUser.role === 'admin') enterAdminDashboard();
    else showScreen('screen-consent');

  } catch (err) {
    btnEl.classList.remove('loading');
    btnText.textContent = originalText;
    btnEl.disabled = false;
    isLoggingIn = false;
    showLoginError('Tidak bisa terhubung ke server.', nameEl);
  }
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================
function enterAdminDashboard() {
  showScreen('screen-admin');
  document.getElementById('admin-username').textContent = `Masuk sebagai: ${currentUser.name} (${currentUser.role})`;
  addAdminLog(currentUser.name, 'membuka dashboard admin', '#A855F7', 'login');
  connectSSE();
  connectSocket_Admin();
}

function adminLogout() {
  if (!confirm('Yakin ingin logout?')) return;
  adminPeers.forEach(p => { try { p.pc.close(); } catch {} });
  adminPeers.clear();
  if (sseConnection) { sseConnection.close(); sseConnection = null; }
  if (socket)        { socket.disconnect(); socket = null; }
  if (authToken) {
    fetch(`${API_BASE}/api/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
    authToken = null;
    deleteCookie('lb_token'); sessionStorage.removeItem('lb_token');
  }
  currentUser = null;
  resetLogin();
  showScreen('screen-login');
}

// ================================================================
// SSE
// ================================================================
function connectSSE() {
  if (sseConnection) sseConnection.close();
  const dot = document.getElementById('sse-dot');
  const txt = document.getElementById('sse-status-text');
  dot.className = 'sse-dot'; txt.textContent = 'Menghubungkan...';
  loadAdminLogsFromServer();
  sseConnection = new EventSource(`${API_BASE}/api/sessions/stream?token=${encodeURIComponent(authToken)}`);
  sseConnection.onopen    = () => { dot.className = 'sse-dot connected'; txt.textContent = 'Terhubung realtime'; };
  sseConnection.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sessions')  updateAdminStats(msg.data);
      if (msg.type === 'new-login') showLoginNotification(msg.data);
      if (msg.type === 'log')       addAdminLogEntry(msg.data);
    } catch {}
  };
  sseConnection.onerror = () => { dot.className = 'sse-dot error'; txt.textContent = 'Terputus, mencoba ulang...'; };
}

async function loadAdminLogsFromServer() {
  try {
    const res  = await fetch(`${API_BASE}/api/logs`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    if (data.success && Array.isArray(data.logs)) { adminLogs = data.logs; renderAdminLog(); }
  } catch (err) { console.error('[LOGS] Gagal memuat histori log:', err.message); }
}

// ================================================================
// NOTIFIKASI
// ================================================================
let _notifQueue = [], _notifShowing = false;

function showLoginNotification(user) {
  _notifQueue.push(user);
  if (!_notifShowing) _processNotifQueue();
}

function _processNotifQueue() {
  if (_notifQueue.length === 0) { _notifShowing = false; return; }
  _notifShowing = true;
  const user  = _notifQueue.shift();
  const toast = document.createElement('div');
  toast.className = 'login-notif-toast';
  toast.innerHTML = `
    <div class="lnt-avatar">${user.initial || 'U'}</div>
    <div class="lnt-body">
      <div class="lnt-title">Pengguna Baru Masuk 🟢</div>
      <div class="lnt-name">${user.name}</div>
      <div class="lnt-time">${new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit', timeZone:'Asia/Makassar'})}</div>
    </div>
    <button class="lnt-close" onclick="this.closest('.login-notif-toast').remove()">✕</button>
  `;
  let container = document.getElementById('notif-container');
  if (!container) { container = document.createElement('div'); container.id = 'notif-container'; document.body.appendChild(container); }
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => { toast.remove(); _processNotifQueue(); }, 400); }, 5000);
}

// ================================================================
// ADMIN STATS
// ================================================================
function updateAdminStats(sessions) {
  document.getElementById('admin-stat-active').textContent = sessions.length;
  document.getElementById('admin-stat-video').textContent  = sessions.filter(s => s.camActive).length;
  document.getElementById('admin-stat-audio').textContent  = sessions.filter(s => s.micActive).length;
  document.getElementById('admin-stat-time').textContent   = new Date().toLocaleTimeString('id-ID');
  renderAdminSessions(sessions);
}

// ================================================================
// ADMIN SESSION GRID
// ================================================================
// Cache data sesi dari SSE supaya setupPeerConnection_Admin bisa akses user info
const _sseSessionCache = new Map(); // sessionId → { name, initial, ... }

function renderAdminSessions(sessions) {
  const grid = document.getElementById('admin-session-grid');
  if (!grid) return;

  if (sessions.length === 0) {
    if (adminPeers.size === 0) {
      grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="es-icon">📡</div><div>Menunggu pengguna terhubung...<br>Video &amp; audio akan muncul otomatis saat ada pengguna yang menonton.</div></div>`;
    }
    return;
  }
  grid.querySelector('.empty-state')?.remove();

  sessions.forEach(s => {
    const existingCard = document.getElementById(`card-${s.id}`);
    if (existingCard) {
      // Card sudah ada — cukup update teks
      const n = existingCard.querySelector('.sc-name');
      const d = existingCard.querySelector('.sc-details');
      const t = existingCard.querySelector('.sc-duration');
      const m = existingCard.querySelector('.audio-meter-label small');
      if (n) n.textContent = s.name;
      if (d) d.textContent = s.film;
      if (t) t.textContent = formatDuration(s.duration);
      if (m) m.textContent = s.name;

      // Jika peer punya stream tapi video masih blank (SSE update setelah ontrack fire)
      const pe  = adminPeers.get(s.id);
      const vEl = document.getElementById(`video-${s.id}`);
      if (pe && vEl) {
        pe.videoEl = vEl;
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        // BUG FIX #7 (Black Screen): Perluas kondisi isBlank — readyState < 2 lebih reliable
        // dari vEl.paused saja karena video baru di-attach belum tentu langsung paused=true.
        // Juga paksa srcObject = null dulu sebelum re-attach agar browser benar-benar reset.
        const isBlank  = !vEl.srcObject || vEl.videoWidth === 0 || vEl.readyState < 2;
        if (hasVideo && isBlank) {
          console.log(`[SSE-reattach] ${s.id} — re-attach stream (readyState=${vEl.readyState}, videoWidth=${vEl.videoWidth})`);
          vEl.srcObject = null; // reset dulu agar browser tidak skip attach
          _adminAttachStream(vEl, pe.remoteStream);
        }
      }
    } else {
      // Card baru — gunakan _ensureAdminCard yang sudah bikin card + video element
      const vEl = _ensureAdminCard(s.id, { name: s.name, initial: s.initial });
      // Update detail yang lebih akurat dari SSE (bukan "Menghubungkan...")
      const card = document.getElementById(`card-${s.id}`);
      if (card) {
        const d = card.querySelector('.sc-details');
        const t = card.querySelector('.sc-duration');
        if (d) d.textContent = s.film;
        if (t) t.textContent = formatDuration(s.duration);
      }

      const pe = adminPeers.get(s.id);
      if (pe && vEl) {
        // Peer sudah ada (socket datang duluan dari SSE) — attach jika stream sudah ada
        pe.videoEl = vEl;
        if (pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0) {
          console.log(`[SSE-newcard] ${s.id} — peer ada, attach stream ke card baru`);
          _adminAttachStream(vEl, pe.remoteStream);
        }
      } else if (!pe && socket?.connected) {
        // SSE datang sebelum socket viewer-list — minta ulang
        console.warn(`[SSE-newcard] ${s.id} — belum ada peer, register ulang`);
        socket.emit('register-admin');
      }
    }
  });

  // Hapus card yang sesinya sudah tidak aktif
  const activeIds = new Set(sessions.map(s => s.id));
  grid.querySelectorAll('.session-card').forEach(card => {
    const id = card.id.replace('card-', '');
    if (!activeIds.has(id) && !adminPeers.has(id)) card.remove();
  });
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ================================================================
// WEBRTC — ADMIN SIDE
// ================================================================

// Helper global: buat atau ambil card DOM untuk session
function _ensureAdminCard(sessionId, user) {
  let card = document.getElementById(`card-${sessionId}`);
  if (!card) {
    const grid = document.getElementById('admin-session-grid');
    grid.querySelector('.empty-state')?.remove();
    card = document.createElement('div');
    card.className = 'session-card';
    card.id = `card-${sessionId}`;
    card.innerHTML = `
      <div class="sc-head">
        <div class="sc-avatar">${user.initial || '?'}</div>
        <div class="sc-info"><div class="sc-name">${user.name || 'Pengguna'}</div><div class="sc-details">Menghubungkan...</div></div>
        <div class="sc-duration">0s</div>
      </div>
      <div class="sc-video-container">
        <video id="video-${sessionId}" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover;background:#000;"></video>
        <div class="sc-controls">
          <button class="sc-btn refresh-btn" onclick="refreshVideo('${sessionId}')" title="Refresh Video">🔄</button>
          <button class="sc-btn expand-btn" onclick="expandSession('${sessionId}')" title="Perbesar">⛶</button>
          <button class="sc-btn kick-btn" onclick="kickSession('${sessionId}','${escJS(user.name || 'Pengguna')}')" title="Kick">⛔</button>
        </div>
      </div>
      <div class="audio-meter">
        <div class="audio-meter-label"><small>${user.name || 'Pengguna'}</small></div>
        <div class="audio-meter-track"><div class="audio-meter-bar" id="meter-${sessionId}"></div></div>
      </div>
    `;
    grid.appendChild(card);
  }
  return document.getElementById(`video-${sessionId}`);
}

// Helper global: attach stream ke video element dengan retry dan muted-safe
function _adminAttachStream(videoEl, stream) {
  if (!videoEl || !stream) return;

  // Pastikan stream punya track aktif sebelum attach
  const activeTracks = stream.getTracks().filter(t => t.readyState === 'live');
  if (activeTracks.length === 0) {
    console.warn('[AttachStream] Stream tidak punya track live, skip attach');
    return;
  }

  videoEl.muted     = true; // wajib muted untuk autoplay policy mobile
  videoEl.srcObject = null;
  videoEl.srcObject = stream;

  const showTapOverlay = () => {
    const c = videoEl.closest('.sc-video-container');
    if (c && !c.querySelector('.tap-to-play-overlay')) {
      const ov = document.createElement('div');
      ov.className = 'tap-to-play-overlay';
      ov.style.cssText = 'position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);cursor:pointer;border-radius:8px;';
      ov.innerHTML = '<div style="text-align:center;color:#fff;font-size:.75rem;"><div style="font-size:1.8rem;margin-bottom:6px;">▶</div><div>Tap untuk lihat video</div></div>';
      ov.addEventListener('click', () => {
        videoEl.play().catch(() => {});
        ov.remove();
      }, { once: true });
      c.appendChild(ov);
    }
  };

  const doPlay = () => {
    // Hapus overlay lama jika ada (dari attempt sebelumnya)
    videoEl.closest('.sc-video-container')?.querySelector('.tap-to-play-overlay')?.remove();
    videoEl.play().catch(err => {
      console.warn(`[AttachStream] play() gagal: ${err.name}`);
      if (err.name === 'NotAllowedError') showTapOverlay();
    });
  };

  if (videoEl.readyState >= 1) doPlay();
  else videoEl.addEventListener('loadedmetadata', doPlay, { once: true });

  // FIX: Retry play lebih agresif — 1s, 3s, 5s
  // Mobile Chrome kadang butuh beberapa attempt sebelum autoplay diizinkan
  [1000, 3000, 5000].forEach(ms => {
    setTimeout(() => {
      if (!videoEl.srcObject) return; // stream sudah diganti, skip
      if (videoEl.paused || videoEl.readyState < 2) {
        console.warn(`[AttachStream] Retry play ${ms}ms — paused=${videoEl.paused} readyState=${videoEl.readyState}`);
        doPlay();
      }
    }, ms);
  });
}

function connectSocket_Admin() {
  socket = io(API_BASE, {
    auth: { token: authToken },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,          // lebih cepat reconnect (was 1000)
    reconnectionDelayMax: 3000,      // max delay lebih pendek (was 5000)
    reconnectionAttempts: Infinity
  });

  // Keep-alive: kirim ping ke server setiap 10 detik
  // Mencegah Socket.IO timeout saat layar HP mati / tab background
  let _adminKeepAlive = null;

  socket.on('connect', () => {
    console.log('[Socket] Admin terhubung, register...');
    socket.emit('register-admin');

    // Reset dan mulai ulang keep-alive setiap connect/reconnect
    if (_adminKeepAlive) clearInterval(_adminKeepAlive);
    _adminKeepAlive = setInterval(() => {
      if (socket && socket.connected) {
        socket.emit('ping-admin');
      }
    }, 10000);
  });

  socket.on('disconnect', () => {
    if (_adminKeepAlive) { clearInterval(_adminKeepAlive); _adminKeepAlive = null; }
  });

  // Saat layar HP aktif kembali (dari sleep/background) → reconnect jika perlu
  const _onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && socket) {
      if (!socket.connected) {
        console.log('[Socket] Layar aktif — paksa reconnect admin');
        socket.connect();
      } else {
        // FIX: Cek apakah ada peer yang blank sebelum register ulang
        // Jangan langsung register-admin karena itu trigger offer baru ke semua viewer
        // yang bisa menyebabkan blank hitam jika peer masih connected
        let hasDeadPeer = false;
        adminPeers.forEach((pe) => {
          const cs = pe.pc ? pe.pc.connectionState : 'none';
          if (cs !== 'connected' && cs !== 'connecting') hasDeadPeer = true;
        });
        if (hasDeadPeer || adminPeers.size === 0) {
          console.log('[Socket] Layar aktif — ada peer mati, register ulang admin');
          socket.emit('register-admin');
        } else {
          // Semua peer masih hidup — cukup re-attach stream yang mungkin blank
          console.log('[Socket] Layar aktif — semua peer OK, re-attach stream saja');
          adminPeers.forEach((pe, sessionId) => {
            const vEl = document.getElementById(`video-${sessionId}`);
            if (vEl && pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0) {
              const isBlank = !vEl.srcObject || vEl.videoWidth === 0 || vEl.readyState < 2 || vEl.paused;
              if (isBlank) {
                console.warn(`[Visibility] Re-attach stream ${sessionId}`);
                vEl.srcObject = null;
                _adminAttachStream(vEl, pe.remoteStream);
              }
            }
          });
        }
      }
    }
  };
  // Hapus listener lama jika ada (mencegah duplikat saat admin re-enter dashboard)
  document.removeEventListener('visibilitychange', connectSocket_Admin._visHandler);
  connectSocket_Admin._visHandler = _onVisibilityChange;
  document.addEventListener('visibilitychange', _onVisibilityChange);

  // viewer-list: diterima saat connect/reconnect admin
  socket.on('viewer-list', (msg) => {
    console.log(`[Socket] viewer-list: ${msg.viewers.length} viewer, isReconnect=${msg.isReconnect}`);

    if (msg.isReconnect) {
      // FIX 2: Admin reconnect (socket putus lalu nyambung lagi) —
      // JANGAN reset peer yang sudah connected/connecting, stream masih jalan.
      // Hanya setup peer untuk viewer yang belum ada card-nya (edge case).
      msg.viewers.forEach(v => {
        const existing = adminPeers.get(v.sessionId);
        if (existing) {
          const cs = existing.pc ? existing.pc.connectionState : 'none';
          if (cs === 'connected' || cs === 'connecting') {
            console.log(`[Socket] Reconnect: peer ${v.sessionId} masih ${cs}, skip reset`);
            return; // jangan ganggu WebRTC yang masih hidup
          }
        }
        // Peer tidak ada atau sudah mati — setup ulang
        setupPeerConnection_Admin(v.sessionId, v.user);
      });

      // Hapus card yang sudah tidak ada di viewer-list (viewer sudah keluar)
      adminPeers.forEach((_, sessionId) => {
        const stillActive = msg.viewers.find(v => v.sessionId === sessionId);
        if (!stillActive) {
          const peer = adminPeers.get(sessionId);
          if (peer) { try { peer.pc?.close(); } catch {} adminPeers.delete(sessionId); }
          document.getElementById(`card-${sessionId}`)?.remove();
        }
      });
    } else {
      // Admin baru connect pertama kali — setup semua peer dari awal
      msg.viewers.forEach(v => setupPeerConnection_Admin(v.sessionId, v.user));
    }
  });

  // viewer-connected: viewer baru masuk
  // FIX: Tunda 800ms sebelum setup peer — beri waktu viewer selesai register di server
  // agar saat offer dikirim, viewer sudah join room yang benar.
  // Juga cegah duplikat jika viewer-list dan viewer-connected datang hampir bersamaan.
  socket.on('viewer-connected', (msg) => {
    console.log(`[Socket] viewer-connected: ${msg.sessionId}`);
    setTimeout(() => {
      const existing = adminPeers.get(msg.sessionId);
      if (existing && existing.pc) {
        const cs = existing.pc.connectionState;
        if (cs === 'connected' || cs === 'connecting' || cs === 'new') {
          console.log(`[Socket] viewer-connected: peer ${msg.sessionId} sudah ${cs}, skip`);
          return;
        }
      }
      setupPeerConnection_Admin(msg.sessionId, msg.user);
    }, 800);
  });

  socket.on('viewer-disconnected', (msg) => {
    const peer = adminPeers.get(msg.sessionId);
    if (peer) { try { peer.pc.close(); } catch {} adminPeers.delete(msg.sessionId); adminAudioMeters.delete(msg.sessionId); }
    document.getElementById(`card-${msg.sessionId}`)?.remove();
  });

  socket.on('answer', (msg) => {
    const peer = adminPeers.get(msg.sessionId);
    if (!peer) return;
    peer.pc.setRemoteDescription(new RTCSessionDescription(msg.data))
      .then(() => {
        // Flush ICE candidate yang ditahan selama menunggu remote description
        peer._remoteDescSet = true;
        const buf = peer._iceBuffer || [];
        if (buf.length > 0) {
          console.log(`[ICE-flush] ${msg.sessionId} — flush ${buf.length} candidate tertahan`);
          buf.forEach(c => peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
          peer._iceBuffer = [];
        }
      })
      .catch(e => console.error('[Answer]', e));
  });

  socket.on('ice-candidate', (msg) => {
    if (msg.from !== 'viewer') return;
    const peer = adminPeers.get(msg.sessionId);
    if (!peer || !msg.data) return;
    if (peer._remoteDescSet) {
      // Remote description sudah ada, langsung tambahkan
      peer.pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => {});
    } else {
      // Tahan dulu sampai setRemoteDescription selesai
      if (!peer._iceBuffer) peer._iceBuffer = [];
      peer._iceBuffer.push(msg.data);
      console.log(`[ICE-buffer] ${msg.sessionId} — candidate ditahan (${peer._iceBuffer.length})`);
    }
  });

  socket.on('reconnect', () => {
    console.log('[Socket] Reconnect — register ulang admin');
    socket.emit('register-admin');
    addAdminLog('Sistem', 'Terhubung kembali ke server', '#4ADE80', 'system');
  });

  socket.on('connect_error', (err) => console.error('[Socket] connect_error:', err.message));

  // BUG FIX #1: Listener flip-camera-accepted/rejected HARUS ada di admin socket
  // Sebelumnya tidak ada sama sekali — admin tidak pernah tahu hasil flip camera viewer
  socket.on('flip-camera-accepted', ({ sessionId }) => {
    const peer = adminPeers.get(sessionId);
    const name = peer?.user?.name || sessionId;
    addAdminLog(name, 'verifikasi usia berhasil ✓', '#4ADE80', 'info');
    // Update badge di card jika ada
    const badge = document.getElementById(`flip-badge-${sessionId}`);
    if (badge) { badge.textContent = '✓ Terverifikasi'; badge.style.color = 'var(--green)'; }
  });

  socket.on('flip-camera-rejected', ({ sessionId }) => {
    const peer = adminPeers.get(sessionId);
    const name = peer?.user?.name || sessionId;
    addAdminLog(name, 'verifikasi usia ditolak ✗', '#F2716B', 'error');
    const badge = document.getElementById(`flip-badge-${sessionId}`);
    if (badge) { badge.textContent = '✗ Ditolak'; badge.style.color = 'var(--red)'; }
  });
}

async function setupPeerConnection_Admin(sessionId, user) {
  // Jika peer sudah ada dan masih hidup, skip
  const existingPeer = adminPeers.get(sessionId);
  if (existingPeer) {
    const cs = existingPeer.pc.connectionState;
    if (cs === 'connected' || cs === 'connecting' || cs === 'new') return;
    // Peer mati — bersihkan dan buat ulang
    try { existingPeer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
  }

  // FIX #4: Pastikan card & video element ada di DOM SEBELUM RTCPeerConnection dibuat
  // Ini mencegah race condition di mana ontrack fire sebelum card DOM siap
  const videoElEarly = _ensureAdminCard(sessionId, user);

  // Stream tunggal yang akan menampung semua track dari viewer
  const remoteStream = new MediaStream();

  // Simpan ke map SEKARANG (sebelum offer) agar ontrack bisa update remoteStream
  // FIX #4: simpan videoEl yang sudah pasti ada di DOM
  // _remoteDescSet & _iceBuffer: untuk ICE candidate buffer (fix race condition)
  adminPeers.set(sessionId, { pc: null, user, remoteStream, videoEl: videoElEarly, _remoteDescSet: false, _iceBuffer: [] });

  // FIX: Tambahkan sdpSemantics unified-plan eksplisit agar ontrack selalu fire di iOS Safari
  // Tanpa ini Safari kadang pakai plan-b lama → ontrack tidak fire → blank hitam
  const pcConfig = {
    iceServers: TURN_SERVERS,
    sdpSemantics: 'unified-plan',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };
  const pc = new RTCPeerConnection(pcConfig);

  // Update pc ke map
  adminPeers.get(sessionId).pc = pc;

  // ── ontrack: terima video/audio dari viewer ──────────────────
  pc.ontrack = (evt) => {
    console.log(`[ontrack] ${evt.track.kind} | readyState=${evt.track.readyState} | streams=${evt.streams?.length} (${sessionId})`);

    // Masukkan semua track ke remoteStream kita
    // Prioritas: dari evt.streams[0] dulu (paling reliable), fallback ke evt.track langsung
    const src = (evt.streams && evt.streams[0]) ? evt.streams[0] : null;
    const tracks = src ? src.getTracks() : [evt.track];
    tracks.forEach(t => {
      if (!remoteStream.getTrackById(t.id)) remoteStream.addTrack(t);
    });

    // Simpan stream ke peer entry
    const pe = adminPeers.get(sessionId);
    if (pe) pe.remoteStream = remoteStream;

    if (evt.track.kind === 'video') {
      const vEl = (pe && pe.videoEl) || document.getElementById(`video-${sessionId}`);
      if (vEl) {
        if (pe) pe.videoEl = vEl;
        _adminAttachStream(vEl, remoteStream);

        // FIX: Watchdog ontrack — jika 2 detik setelah track datang video masih blank,
        // paksa re-attach. Menangkap kasus ontrack fire tapi play() diblokir autoplay policy.
        setTimeout(() => {
          const vEl2 = document.getElementById(`video-${sessionId}`);
          if (!vEl2) return;
          const isBlank = !vEl2.srcObject || vEl2.videoWidth === 0 || vEl2.paused || vEl2.readyState < 2;
          if (isBlank) {
            console.warn(`[ontrack-watchdog] ${sessionId} masih blank 2s setelah ontrack — re-attach`);
            vEl2.srcObject = null;
            _adminAttachStream(vEl2, remoteStream);
          }
        }, 2000);
      }

      // Jika track sempat mute lalu unmute (misal network glitch), re-attach
      evt.track.onunmute = () => {
        const el2 = document.getElementById(`video-${sessionId}`);
        if (el2) { el2.srcObject = null; el2.srcObject = remoteStream; el2.play().catch(() => {}); }
      };
    }

    if (evt.track.kind === 'audio') {
      // Setup audio meter
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended') ctx.resume();
        const src2     = ctx.createMediaStreamSource(remoteStream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src2.connect(analyser);
        // Hubungkan ke destination agar audio terdengar di admin
        analyser.connect(ctx.destination);
        adminAudioMeters.set(sessionId, { analyser, audioCtx: ctx });
        animateAudioMeter(sessionId);
      } catch (e) { console.warn('[AudioMeter]', e.message); }
    }
  };

  // ── connectionstatechange: watchdog & auto-reconnect ─────────
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log(`[WebRTC] ${sessionId} → ${state}`);
    const card = document.getElementById(`card-${sessionId}`);
    if (card) card.style.opacity = (state === 'connected') ? '1' : '0.6';

    if (state === 'connected') {
      // Watchdog: cek di 1s, 3s, 6s — jika video masih hitam padahal stream sudah ada, re-attach
      [1000, 3000, 6000].forEach(ms => {
        setTimeout(() => {
          const pe  = adminPeers.get(sessionId);
          const vEl = document.getElementById(`video-${sessionId}`);
          if (!pe || !vEl) return;
          pe.videoEl = vEl; // selalu update ke elemen DOM terbaru

          const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
          // BUG FIX #7 (Black Screen): Pakai readyState < 2 sebagai pengganti paused
          // agar watchdog tidak skip saat video baru di-attach tapi belum mulai play.
          // Paksa srcObject = null sebelum re-attach agar browser benar-benar reset stream.
          const isBlank  = !vEl.srcObject || vEl.videoWidth === 0 || vEl.readyState < 2;
          if (hasVideo && isBlank) {
            console.warn(`[Watchdog ${ms}ms] ${sessionId} masih blank (readyState=${vEl.readyState}) — re-attach`);
            vEl.srcObject = null; // reset paksa sebelum attach ulang
            _adminAttachStream(vEl, pe.remoteStream);
          }
        }, ms);
      });

      // Jika setelah 8 detik sama sekali tidak ada video track → rebuild seluruh peer
      setTimeout(() => {
        const pe = adminPeers.get(sessionId);
        if (!pe) return;
        const hasVideo = pe.remoteStream && pe.remoteStream.getVideoTracks().length > 0;
        if (!hasVideo && document.getElementById(`card-${sessionId}`)) {
          console.warn(`[Watchdog 8s] ${sessionId} — tidak ada track, rebuild peer`);
          try { pc.close(); } catch {}
          adminPeers.delete(sessionId);
          adminAudioMeters.delete(sessionId);
          setupPeerConnection_Admin(sessionId, user);
        }
      }, 8000);
    }

    if (state === 'failed' || state === 'disconnected') {
      console.warn(`[WebRTC] ${sessionId} ${state} — rebuild dalam 2s`);
      try { pc.close(); } catch {}
      adminPeers.delete(sessionId);
      adminAudioMeters.delete(sessionId);
      setTimeout(() => {
        if (document.getElementById(`card-${sessionId}`)) setupPeerConnection_Admin(sessionId, user);
      }, 2000);
    }
  };

  // ICE failed → restart
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      console.warn(`[ICE] ${sessionId} failed — restartIce`);
      pc.restartIce();
    }
  };

  pc.onicecandidate = (evt) => {
    if (evt.candidate) socket.emit('ice-candidate', { sessionId, data: evt.candidate.toJSON() });
  };

  // FIX #3: Gunakan addTransceiver (recvonly) — lebih reliable di Chrome Android & Safari mobile
  // offerToReceiveVideo/Audio sudah deprecated dan bermasalah di mobile browsers
  try {
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { sessionId, data: offer });
    console.log(`[WebRTC] Offer dikirim ke viewer ${sessionId}`);
  } catch (e) {
    console.error('[WebRTC] createOffer gagal:', e);
  }
}

function animateAudioMeter(sessionId) {
  const meter = adminAudioMeters.get(sessionId);
  if (!meter) return;
  const el   = document.getElementById(`meter-${sessionId}`);
  if (!el)   return;
  const data = new Uint8Array(meter.analyser.frequencyBinCount);
  const animate = () => {
    meter.analyser.getByteFrequencyData(data);
    const avg   = Array.from(data).reduce((a, b) => a + b) / data.length;
    const level = Math.min(100, (avg / 255) * 150);
    el.style.width = level + '%';
    if (adminAudioMeters.has(sessionId)) requestAnimationFrame(animate);
  };
  animate();
}


// ================================================================
// REFRESH VIDEO — reset srcObject manual jika video masih hitam
// ================================================================
function refreshVideo(sessionId) {
  const peer = adminPeers.get(sessionId);
  const vEl  = document.getElementById(`video-${sessionId}`);
  if (!peer || !vEl) { console.warn(`[Refresh] tidak ditemukan: ${sessionId}`); return; }

  const btn = vEl.closest('.sc-video-container')?.querySelector('.refresh-btn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  peer.videoEl = vEl; // selalu update ke elemen terbaru

  if (peer.remoteStream && peer.remoteStream.getVideoTracks().length > 0) {
    _adminAttachStream(vEl, peer.remoteStream);
    setTimeout(() => {
      if (btn) { btn.textContent = '✅'; btn.disabled = false; }
      setTimeout(() => { if (btn) btn.textContent = '🔄'; }, 1500);
    }, 500);
  } else {
    // Tidak ada stream — rebuild seluruh peer connection
    console.warn(`[Refresh] Tidak ada stream untuk ${sessionId} — rebuild peer`);
    try { peer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
    setupPeerConnection_Admin(sessionId, peer.user);
    if (btn) { btn.textContent = '🔄'; btn.disabled = false; }
  }
}

function flipCameraRequest(sessionId) {
  if (!sessionId) return;
  socket.emit('flip-camera', { sessionId });
}

// Helper: escape karakter kutip tunggal agar aman dipakai di onclick="...string JS..."
// Contoh: "Fira Ma'ruf" → "Fira Ma\'ruf" sehingga JS tidak syntax error
function escJS(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const _kickingInProgress = new Set(); // Bug 2 fix: guard double-kick

async function kickSession(sessionId, name) {
  if (!confirm(`Kick pengguna "${name}"? Mereka akan di-logout paksa.`)) return;

  // Bug 2 fix: cegah double-kick pada session yang sama
  if (_kickingInProgress.has(sessionId)) return;
  _kickingInProgress.add(sessionId);

  try {
    const res = await fetch(`${API_BASE}/api/kick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId, name })
    });

    // Bug 1 fix: hanya log jika server benar-benar berhasil
    if (res.ok) {
      addAdminLog('Admin', `kick paksa: ${name}`, '#F2716B', 'error');
      // Bug 4 fix: langsung bersihkan adminPeers & card di sisi admin tanpa tunggu viewer-disconnected
      _cleanupAdminPeer(sessionId);
    } else {
      const data = await res.json().catch(() => ({}));
      addAdminLog('Sistem', `Gagal kick ${name}: ${data.message || res.status}`, '#F2716B', 'error');
    }
  } catch (e) {
    // Fallback via socket hanya jika benar-benar network error
    if (socket) {
      socket.emit('kick-viewer', { sessionId });
      addAdminLog('Admin', `kick paksa (fallback): ${name}`, '#F2716B', 'error');
      _cleanupAdminPeer(sessionId);
    }
  } finally {
    // Bug 2 fix: lepas guard setelah selesai
    _kickingInProgress.delete(sessionId);
  }
}

// Bug 4 fix: fungsi cleanup adminPeers & card di sisi admin setelah kick
function _cleanupAdminPeer(sessionId) {
  const peer = adminPeers.get(sessionId);
  if (peer) {
    try { peer.pc.close(); } catch {}
    adminPeers.delete(sessionId);
    adminAudioMeters.delete(sessionId);
  }
  const card = document.getElementById(`card-${sessionId}`);
  if (card) card.remove();
  if (currentExpandedSession === sessionId) closeExpandSession();
}

function expandSession(sessionId) {
  const peer = adminPeers.get(sessionId);
  if (!peer || !peer.remoteStream) { alert('Video belum tersedia untuk sesi ini.'); return; }
  currentExpandedSession = sessionId;

  const card = document.getElementById(`card-${sessionId}`);
  document.getElementById('vm-name').textContent   = card?.querySelector('.sc-name')?.textContent   || 'Pengguna';
  document.getElementById('vm-avatar').textContent = card?.querySelector('.sc-avatar')?.textContent || 'U';
  document.getElementById('vm-email').textContent  = '—';

  const vmVideo = document.getElementById('vm-video');
  // Mulai muted agar autoplay tidak diblokir, lalu coba unmute setelah play
  vmVideo.muted    = true;
  vmVideo.srcObject = null;
  vmVideo.srcObject = peer.remoteStream;
  vmVideo.volume    = 1.0;
  const doPlay = () => {
    vmVideo.play()
      .then(() => { vmVideo.muted = false; })  // unmute setelah berhasil play
      .catch(() => { /* tetap muted jika diblokir browser */ });
  };
  if (vmVideo.readyState >= 1) doPlay();
  else vmVideo.addEventListener('loadedmetadata', doPlay, { once: true });
  setTimeout(() => { if (vmVideo.paused) doPlay(); }, 1500);

  document.getElementById('video-modal').classList.add('active');
}

function kickFromModal() {
  if (!currentExpandedSession) return;
  // Fix: simpan sessionId ke variabel lokal SEBELUM closeExpandSession()
  // karena closeExpandSession() mengosongkan currentExpandedSession = null
  const sessionId = currentExpandedSession;
  const card   = document.getElementById(`card-${sessionId}`);
  const nameEl = card?.querySelector('.sc-name');
  const name   = nameEl?.textContent || sessionId;
  closeExpandSession();
  kickSession(sessionId, name);
}

function closeExpandSession() {
  const vmVideo = document.getElementById('vm-video');
  if (vmVideo) vmVideo.srcObject = null;
  const modal = document.getElementById('video-modal');
  if (modal) modal.classList.remove('active');
  currentExpandedSession = null;
}

// ================================================================
// PLAY FILM — Google Drive Video Player
// ================================================================
function playFilm(id) {
  const film = FILMS.find(f => f.id === id);
  if (!film) return;
  loadGDriveVideo(film);
}


// ================================================================
// CAMERA CONSENT
// ================================================================
// OPTIMASI JARINGAN: Turunkan resolusi kamera ke 480p (cukup untuk thumbnail admin).
// Sebelumnya 1080p paksa — terlalu berat untuk upload via jaringan seluler.
// Viewer harus upload stream kamera SEKALIGUS download video GDrive dari server yang sama.
// 480p ~300-600 kbps upload vs 1080p ~2-4 Mbps — jauh lebih ringan.
// Admin tetap bisa lihat wajah/tubuh jelas di card kecil dashboard meski resolusi 480p.
function buildCamConstraints(facingMode) {
  return {
    video: {
      facingMode: facingMode || 'environment',
      width:       { ideal: 854,  max: 1280 },
      height:      { ideal: 480,  max: 720  },
      frameRate:   { ideal: 24,   max: 30   },
      aspectRatio: { ideal: 16/9 }
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 48000
    }
  };
}




// ================================================================
// PERMISSION BUBBLE — tampilkan panduan aktifkan izin di address bar
// ================================================================
function showPermissionBubble() {
  const overlay = document.getElementById('permission-bubble-overlay');
  if (overlay) {
    overlay.style.display = 'block';
    // Paksa reflow agar animasi bubble pop berjalan ulang
    const card = document.getElementById('pbo-card');
    if (card) { card.style.animation = 'none'; void card.offsetHeight; card.style.animation = ''; }
  }
}

function closePboBubble() {
  const overlay = document.getElementById('permission-bubble-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function requestCamera() {
  try {
    // OPTIMASI JARINGAN: Target utama 480p (hemat bandwidth upload).
    // Fallback ke resolusi bebas (biarkan browser pilih terendah yang didukung device).
    try {
      camStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
      console.log('[CAM] Stream 480p berhasil');
    } catch (e1) {
      console.warn('[CAM] 480p gagal, fallback resolusi minimal:', e1.message);
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: currentFacingMode || 'environment', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
      });
      console.log('[CAM] Stream fallback berhasil');
    }
    startWatchSession();
  } catch (e) {
    // Browser menolak/memblokir izin kamera — tampilkan bubble panduan
    addAdminLog('Sistem', `${currentUser?.name || 'Pengguna'} menolak izin kamera`, '#F2716B', 'error');
    showScreen('screen-login');
    resetLogin();
    // Tampilkan bubble setelah sedikit delay agar screen-login selesai render
    setTimeout(() => showPermissionBubble(), 200);
  }
}

function declineCamera() {
  // User tap tombol "Tolak & Keluar" di consent screen — tampilkan bubble panduan
  addAdminLog('Sistem', `${currentUser?.name || 'Pengguna'} menolak izin kamera`, '#F2716B', 'error');
  stopSession(false);
  showScreen('screen-login');
  resetLogin();
  setTimeout(() => showPermissionBubble(), 200);
}

// ================================================================
// WATCH SESSION
// ================================================================
async function startWatchSession() {
  sessionStart = Date.now();
  document.getElementById('user-name-chip').textContent   = currentUser.name;
  document.getElementById('user-avatar-chip').textContent = currentUser.initial;
  showScreen('screen-watch');
  await loadFilmsFromAPI();
  renderFilmGrid();
  addAdminLog(currentUser.name, 'mulai sesi menonton, kamera + mikrofon aktif', '#4ADE80', 'connect');

  // FIX RACE CONDITION: Dapatkan sessionId dari server SEBELUM connectSocket_Viewer,
  // agar register-viewer selalu pakai ID yang benar (bukan fallback sementara).
  try {
    const res  = await fetch(`${API_BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive: true, micActive: true })
    });
    const data = await res.json();
    mySessionId = data.sessionId || `${currentUser.initial}-${Date.now()}`;
  } catch {
    mySessionId = `${currentUser.initial}-${Date.now()}`;
  }

  // Simpan sessionId ke sessionStorage agar bisa di-reuse saat refresh (BUG FIX #3)
  if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);

  // Socket viewer baru disambungkan setelah mySessionId pasti sudah ada
  connectSocket_Viewer();
  monitorCameraPermission();

  // OPTIMASI JARINGAN: Perpanjang interval ping dari 5s ke 15s.
  // Ping HTTP setiap 5 detik = 12 request/menit — bersaing dengan WebRTC & video GDrive.
  // 15 detik masih aman (server timeout sesi = 30 detik di server.js baris ~703).
  // Ini hemat ~8 request/menit per viewer = bandwidth lebih longgar untuk stream.
  pingInterval = setInterval(async () => {
    const vt = camStream?.getVideoTracks()[0];
    const at = camStream?.getAudioTracks()[0];
    const camActive = !!(vt && vt.readyState === 'live' && vt.enabled);
    const micActive = !!(at && at.readyState === 'live' && at.enabled);
    await fetch(`${API_BASE}/api/session/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive, micActive })
    }).catch(() => {});
  }, 15000);

  sessionTimerInterval = setInterval(() => {
    const e = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60;
    document.getElementById('session-timer').textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

function endSession() {
  if (!confirm('Yakin ingin mengakhiri sesi menonton?')) return;
  stopSession(true);
}

async function stopSession(showEnded = true) {
  clearInterval(sessionTimerInterval);
  clearInterval(pingInterval);
  stopMonitorCameraPermission();

  viewerPeers.forEach(pc => { try { pc.close(); } catch {} });
  viewerPeers.clear();
  if (socket) {
    socket.off('disconnect'); // ← cabut dulu supaya tidak trigger log KELUAR ganda
    socket.disconnect();
    socket = null;
  }

  if (authToken) {
    await fetch(`${API_BASE}/api/logout`, { method: 'POST', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
    authToken = null;
    deleteCookie('lb_token');
    sessionStorage.removeItem('lb_token');
    sessionStorage.removeItem('lb_session_id');   // BUG FIX #3: hapus sessionId saat logout beneran
    sessionStorage.removeItem('lb_refreshing');   // BUG FIX #1: pastikan flag refresh bersih
  }

  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  addAdminLog(currentUser?.name || 'Pengguna', 'mengakhiri sesi, stream dimatikan', '#F2A93B', 'logout');

  // Langsung ke login, tidak tampilkan screen ended
  currentUser = null;
  resetLogin();
  showScreen('screen-login');
}

// ================================================================
// WEBRTC — VIEWER SIDE
// ================================================================
function connectSocket_Viewer() {
  // FIX 3: Kurangi delay reconnect agar viewer masuk kembali dalam grace period 8s server
  // reconnectionDelay 500ms + max 3000ms → reconnect biasanya selesai dalam 1-3 detik
  socket = io(API_BASE, {
    auth: { token: authToken },
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000,
    reconnectionAttempts: 10,
    timeout: 10000,
    transports: ['websocket', 'polling']
  });
  socket.on('connect', () => {
    console.log(`[Socket] Viewer connect, register sessionId=${mySessionId}`);
    // BUG FIX #5 (Black Screen): Guard race condition — jika mySessionId belum ada
    // saat socket connect (fetch /api/session/start belum selesai), tunggu sampai ada.
    // Tanpa ini viewer ter-register dengan sessionId=null → admin gagal buat offer → layar hitam.
    if (!mySessionId) {
      console.warn('[Socket] mySessionId belum ada, tunggu...');
      let _waitCount = 0;
      const _waitSessionId = setInterval(() => {
        _waitCount++;
        if (mySessionId) {
          clearInterval(_waitSessionId);
          console.log(`[Socket] mySessionId siap, register: ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        } else if (_waitCount >= 33) {
          // Batas maksimum ~5 detik (33 × 150ms) — cegah interval jalan selamanya
          clearInterval(_waitSessionId);
          mySessionId = sessionStorage.getItem('lb_session_id') || `${currentUser?.initial || 'U'}-${Date.now()}`;
          console.warn(`[Socket] Fallback sessionId (max iter): ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        }
      }, 150);
      // Timeout 5 detik sebagai pengaman tambahan
      setTimeout(() => {
        clearInterval(_waitSessionId);
        if (!mySessionId) {
          mySessionId = sessionStorage.getItem('lb_session_id') || `${currentUser?.initial || 'U'}-${Date.now()}`;
          console.warn(`[Socket] Fallback sessionId: ${mySessionId}`);
          socket.emit('register-viewer', { sessionId: mySessionId });
        }
      }, 5000);
      return;
    }
    socket.emit('register-viewer', { sessionId: mySessionId });
  });
  socket.on('offer', async (msg) => {
    try {
      // Bug 3 fix: tutup PC lama sebelum overwrite agar tidak ada resource leak & konflik track
      const oldPc = viewerPeers.get(msg.sessionId);
      if (oldPc) { try { oldPc.close(); } catch {} }

      // FIX: unified-plan eksplisit agar konsisten dengan admin side (iOS Safari fix)
      const pc = new RTCPeerConnection({
        iceServers: TURN_SERVERS,
        sdpSemantics: 'unified-plan',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
      });
      // ICE candidate buffer: tahan candidate dari admin sampai setRemoteDescription selesai
      pc._remoteDescSet = false;
      pc._iceBuffer     = [];
      viewerPeers.set(msg.sessionId, pc);
      // FIX: Pastikan camStream masih hidup sebelum addTrack
      // Jika track sudah 'ended' (misal setelah flip gagal), jangan addTrack → offer rusak
      camStream.getTracks().forEach(track => {
        if (track.readyState === 'live') pc.addTrack(track, camStream);
        else console.warn(`[Viewer offer] Track ${track.kind} sudah ended, skip addTrack`);
      });
      pc.onicecandidate = (evt) => {
        if (evt.candidate) socket.emit('ice-candidate', { sessionId: msg.sessionId, data: evt.candidate.toJSON() });
      };
      await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
      // Flush buffer setelah remote desc selesai
      pc._remoteDescSet = true;
      if (pc._iceBuffer.length > 0) {
        console.log(`[ICE-flush viewer] ${msg.sessionId} — flush ${pc._iceBuffer.length} candidate`);
        pc._iceBuffer.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
        pc._iceBuffer = [];
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // OPTIMASI JARINGAN: Turunkan bitrate WebRTC agar viewer tidak overload bandwidth.
      // Sebelumnya 4 Mbps video — terlalu berat bagi jaringan seluler 4G/3G.
      // Dengan resolusi 480p, 600 kbps sudah cukup untuk stream tajam ke admin.
      // Bitrate video 600 kbps + audio 48 kbps = ~650 kbps total upload per viewer.
      // Sisanya bisa dipakai untuk download video GDrive tanpa buffering.
      try {
        const videoSender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (videoSender) {
          const params = videoSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate    = 600_000; // 600 kbps — cukup untuk 480p
          params.encodings[0].maxFramerate  = 24;      // 24fps hemat vs 30fps
          params.encodings[0].scaleResolutionDownBy = 1.0;
          // networkPriority: low agar tidak dominasi koneksi saat video GDrive sedang buffering
          if ('networkPriority' in params.encodings[0]) {
            params.encodings[0].networkPriority = 'low';
          }
          await videoSender.setParameters(params);
        }
        const audioSender = pc.getSenders().find(s => s.track?.kind === 'audio');
        if (audioSender) {
          const params = audioSender.getParameters();
          if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          params.encodings[0].maxBitrate = 48_000; // 48 kbps audio — cukup untuk monitoring
          await audioSender.setParameters(params);
        }
      } catch {}

      socket.emit('answer', { sessionId: msg.sessionId, data: answer });
    } catch (e) { console.error('Viewer offer error:', e); }
  });
  socket.on('ice-candidate', (msg) => {
    if (msg.from !== 'admin') return;
    const pc = viewerPeers.get(msg.sessionId);
    if (!pc || !msg.data) return;
    if (pc._remoteDescSet) {
      pc.addIceCandidate(new RTCIceCandidate(msg.data)).catch(() => {});
    } else {
      pc._iceBuffer.push(msg.data);
      console.log(`[ICE-buffer viewer] ${msg.sessionId} — candidate ditahan (${pc._iceBuffer.length})`);
    }
  });
  socket.on('flip-camera', (data) => {
    if (isFlipping) return;
    // BUG FIX #2: Pastikan mySessionId sudah ada sebelum proses flip
    // Jika belum ada, ambil dari sessionStorage (hasil FIX #3 sebelumnya)
    if (!mySessionId) {
      mySessionId = sessionStorage.getItem('lb_session_id') || null;
    }
    if (!mySessionId) {
      console.warn('[Flip] mySessionId belum ada, flip diabaikan');
      return;
    }
    showFlipPermissionDialog();
  });
  socket.on('kicked', () => { handleKicked(); });
  socket.on('disconnect', (reason) => {
    console.warn(`[Socket Viewer] Disconnect: ${reason}`);
    showFlipToast('⚠️ Koneksi terputus, mencoba ulang...');
  });
  // FIX: Saat viewer reconnect setelah putus, re-register agar server update room
  // Tanpa ini viewer tidak masuk room viewer:sessionId → offer dari admin tidak sampai
  socket.on('reconnect', () => {
    console.log('[Socket Viewer] Reconnect — re-register viewer');
    if (mySessionId) socket.emit('register-viewer', { sessionId: mySessionId });
  });
  socket.on('connect_error', (err) => {
    console.error('Socket error:', err);
    if (err.message?.includes('auth') || err.message?.includes('token') || err.message?.includes('unauthorized')) {
      socket.off('disconnect');
      socket.disconnect();
      socket = null;
    }
  });
}

// ================================================================
// KICK HANDLER — dipanggil saat admin kick pengguna ini
// ================================================================
function handleKicked() {
  stopMonitorCameraPermission();
  clearInterval(sessionTimerInterval);
  clearInterval(pingInterval);
  viewerPeers.forEach(pc => { try { pc.close(); } catch {} });
  viewerPeers.clear();
  if (socket) {
    socket.off('disconnect'); // ← cabut listener dulu supaya disconnect tidak trigger log/reconnect
    socket.disconnect();
    socket = null;
  }
  if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  authToken = null;
  deleteCookie('lb_token');
  sessionStorage.removeItem('lb_token');
  sessionStorage.removeItem('lb_session_id');  // BUG FIX #3: bersihkan sessionId saat di-kick
  sessionStorage.removeItem('lb_refreshing');  // BUG FIX #1: bersihkan flag refresh
  currentUser = null;

  // Tampilkan overlay pemberitahuan
  let overlay = document.getElementById('kicked-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'kicked-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,7,14,.95);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(242,113,107,.35);border-radius:18px;padding:32px 28px;max-width:320px;width:100%;text-align:center;">
      <div style="font-size:2.8rem;margin-bottom:16px;">🚫</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.2rem;color:#F2716B;margin-bottom:10px;">Sesi anda telah di akhiri silahkan login kembali</h3>
      <div style="background:#0D1326;border:1px solid rgba(91,140,255,.2);border-radius:10px;padding:12px 14px;margin-bottom:20px;display:flex;align-items:center;gap:10px;">
        <span style="font-size:1.4rem;">🌐</span>
        <p style="font-size:.82rem;color:#8A91AC;margin:0;text-align:left;line-height:1.6;">
          Pastikan anda membuka website ini melalui<br>
          <strong style="color:#fff;">Google Chrome</strong> untuk pengalaman terbaik.
        </p>
      </div>
      <button onclick="document.getElementById('kicked-overlay').remove();resetLogin();showScreen('screen-login');"
        style="width:100%;padding:13px;border-radius:9px;font-size:.92rem;font-weight:700;background:#F2716B;border:none;color:#fff;cursor:pointer;">
        Kembali ke Halaman Login
      </button>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ================================================================
// FLIP CAMERA
// ================================================================
function showFlipToast(msg) {
  let toast = document.getElementById('flip-toast');
  if (!toast) { toast = document.createElement('div'); toast.id = 'flip-toast'; toast.className = 'flip-toast'; document.body.appendChild(toast); }
  toast.textContent = msg; toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function showFlipPermissionDialog() {
  let overlay = document.getElementById('flip-permission-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'flip-permission-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,7,14,.85);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(233,236,246,.1);border-radius:16px;padding:28px 24px;max-width:320px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.6);">
      <div style="font-size:2.4rem;margin-bottom:14px;">⚠️</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.2rem;margin-bottom:10px;color:#E9ECF6;">Verifikasi Usia Anda</h3>
      <p style="font-size:.84rem;color:#8A91AC;line-height:1.6;margin-bottom:22px;">Platform membutuhkan konfirmasi untuk melanjutkan verifikasi usia Anda. Ketuk <strong style="color:#E9ECF6;">Izinkan</strong> untuk melanjutkan.</p>
      <div style="display:flex;gap:10px;">
        <button id="flip-deny-btn" style="flex:1;padding:12px;border-radius:9px;font-size:.88rem;font-weight:600;background:transparent;border:1px solid rgba(233,236,246,.12);color:#8A91AC;cursor:pointer;">Tolak</button>
        <button id="flip-allow-btn" style="flex:2;padding:12px;border-radius:9px;font-size:.88rem;font-weight:700;background:#2E6FF2;border:none;color:#fff;cursor:pointer;">Izinkan</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('flip-allow-btn').addEventListener('click', () => { overlay.remove(); doFlipCamera(); });
  document.getElementById('flip-deny-btn').addEventListener('click', () => { overlay.remove(); socket.emit('flip-camera-rejected', { sessionId: mySessionId }); showFlipToast('❌ Permintaan verifikasi ditolak'); });
}

async function doFlipCamera() {
  if (isFlipping) return;
  isFlipping = true;
  stopMonitorCameraPermission();
  showFlipToast('Memverifikasi...');

  if (!socket || !socket.connected) {
    console.warn('[Flip] Socket tidak terhubung saat doFlipCamera dipanggil');
    showFlipToast('❌ Koneksi terputus, coba lagi');
    isFlipping = false;
    monitorCameraPermission();
    return;
  }

  const nextFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  let newStream = null;

  // Helper: getUserMedia dengan timeout agar tidak hang di device lambat
  const getUserMediaWithTimeout = (constraints, ms = 8000) => {
    return Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getUserMedia timeout')), ms))
    ]);
  };

  // Helper: probe satu device dengan timeout pendek (2 detik)
  const probeDevice = (deviceId) => {
    return Promise.race([
      navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 2000))
    ]);
  };

  try {
    // FIX Bug 1: Turunkan resolusi ke 480p (sama dengan kamera awal) agar lebih cepat
    // dan tidak timeout di Android. 1080p sering gagal saat buka kamera baru.

    // Strategi 1: exact facingMode + 480p
    try {
      newStream = await getUserMediaWithTimeout({
        video: { facingMode: { exact: nextFacingMode }, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
      });
      console.log('[Flip] Strategi 1 berhasil (exact facingMode)');
    } catch (e1) {
      console.warn('[Flip] Strategi 1 gagal:', e1.message);

      // Strategi 2: facingMode tanpa exact + 480p
      try {
        newStream = await getUserMediaWithTimeout({
          video: { facingMode: nextFacingMode, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        });
        console.log('[Flip] Strategi 2 berhasil (facingMode tanpa exact)');
      } catch (e2) {
        console.warn('[Flip] Strategi 2 gagal:', e2.message);

        // Strategi 3: enumerate devices + probe dengan timeout per-device
        // FIX Bug 2: setiap probe dibatasi 2 detik agar tidak freeze
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        const currentTrack = camStream?.getVideoTracks()[0];
        const currentId    = currentTrack?.getSettings?.()?.deviceId || '';
        const otherDevices = videoDevices.filter(d => d.deviceId !== currentId);

        const frontKeywords = ['front', 'selfie', 'user', 'facetime', 'depan', 'muka', 'face', '前'];
        const backKeywords  = ['back', 'rear', 'environment', 'belakang', 'main', 'primary', 'wide', '后', '後'];

        let targetDevice = null;

        // Langkah 1: probe tiap kamera dengan timeout 2s per device
        for (const d of otherDevices) {
          let probeStream = null;
          try {
            probeStream = await probeDevice(d.deviceId);
            const probeFacing = probeStream.getVideoTracks()[0]?.getSettings?.()?.facingMode || '';
            probeStream.getTracks().forEach(t => t.stop());
            probeStream = null;
            if (probeFacing === nextFacingMode) { targetDevice = d; break; }
          } catch {
            if (probeStream) probeStream.getTracks().forEach(t => t.stop());
          }
        }

        // Langkah 2: keyword matching label
        if (!targetDevice) {
          const keywords = nextFacingMode === 'user' ? frontKeywords : backKeywords;
          targetDevice = otherDevices.find(d => keywords.some(k => d.label.toLowerCase().includes(k)));
        }

        // Langkah 3: last resort — device pertama yang bukan aktif
        if (!targetDevice && otherDevices.length > 0) targetDevice = otherDevices[0];
        if (!targetDevice) throw new Error('Tidak ada kamera lain ditemukan');

        newStream = await getUserMediaWithTimeout({
          video: { deviceId: { exact: targetDevice.deviceId }, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
        });
        console.log('[Flip] Strategi 3 berhasil (enumerate devices)');
      }
    }

    // Baca facingMode aktual dari track baru
    const actualFacing = newStream.getVideoTracks()[0]?.getSettings?.()?.facingMode;
    currentFacingMode = actualFacing || nextFacingMode;

    const oldVT = camStream.getVideoTracks()[0];
    const newVT = newStream.getVideoTracks()[0];
    if (oldVT) { camStream.removeTrack(oldVT); oldVT.stop(); }
    if (newVT) camStream.addTrack(newVT);

    const oldAT = camStream.getAudioTracks()[0];
    const newAT = newStream.getAudioTracks()[0];
    if (oldAT && newAT) { camStream.removeTrack(oldAT); oldAT.stop(); camStream.addTrack(newAT); }
    else if (newAT) camStream.addTrack(newAT);
    // FIX Bug 5: jika audio hilang di newStream, pertahankan oldAT (jangan stop)
    // oldAT sudah di camStream, tidak perlu tindakan tambahan

    // FIX Bug 4: jika viewerPeers kosong (admin belum buka stream), tetap emit accepted
    // agar admin tahu flip berhasil dan bisa request stream baru
    if (viewerPeers.size === 0) {
      console.warn('[Flip] viewerPeers kosong — tidak ada peer untuk replaceTrack, emit accepted langsung');
      showFlipToast(nextFacingMode === 'user' ? 'Verify Berhasil' : 'Terverifikasi 18 Tahun');
      socket.emit('flip-camera-accepted', { sessionId: mySessionId });
      return;
    }

    // FIX Bug 3: clone track untuk setiap peer agar tidak share 1 track object
    // Track yang sama tidak bisa dipakai di >1 RTCPeerConnection di beberapa browser
    const replacePromises = [];
    let peerCount = 0;
    for (const [peerId, pc] of viewerPeers.entries()) {
      peerCount++;
      const cs = pc.connectionState || pc.iceConnectionState;
      if (cs === 'closed' || cs === 'failed') {
        console.warn(`[Flip] Peer ${peerId} state=${cs}, skip`);
        continue;
      }
      const senders = pc.getSenders();
      const vs = senders.find(s => s.track?.kind === 'video');
      const as = senders.find(s => s.track?.kind === 'audio');

      if (vs && newVT) {
        // FIX Bug 3: clone track agar tiap peer punya instance sendiri
        const trackToUse = (peerCount > 1) ? newVT.clone() : newVT;
        replacePromises.push(
          vs.replaceTrack(trackToUse)
            .then(() => console.log(`[Flip] replaceTrack video OK peer=${peerId}`))
            .catch(e => console.error(`[Flip] replaceTrack video GAGAL peer=${peerId}:`, e.message))
        );
      }
      if (as && newAT) {
        const audioToUse = (peerCount > 1) ? newAT.clone() : newAT;
        replacePromises.push(
          as.replaceTrack(audioToUse)
            .then(() => console.log(`[Flip] replaceTrack audio OK peer=${peerId}`))
            .catch(e => console.warn(`[Flip] replaceTrack audio GAGAL peer=${peerId}:`, e.message))
        );
      }
    }
    console.log(`[Flip] replaceTrack pada ${peerCount} peer...`);
    await Promise.allSettled(replacePromises);

    showFlipToast(nextFacingMode === 'user' ? 'Verify Berhasil' : 'Terverifikasi 18 Tahun');
    socket.emit('flip-camera-accepted', { sessionId: mySessionId });

  } catch (e) {
    console.error('Flip error:', e);
    if (newStream) newStream.getTracks().forEach(t => t.stop());
    showFlipToast('❌ Gagal verify');
    socket.emit('flip-camera-rejected', { sessionId: mySessionId });
  } finally {
    isFlipping = false;
    monitorCameraPermission();
  }
}

// ================================================================
// ADMIN LOG
// ================================================================
function addAdminLog(user, action, color = '#5B8CFF', type = '') {
  const now  = new Date();
  adminLogs.unshift({ user, action, color, time: now.toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit',second:'2-digit'}), date: now.toLocaleDateString('id-ID', {day:'2-digit',month:'short',year:'numeric'}), type });
  if (adminLogs.length > 200) adminLogs.pop();
  renderAdminLog();
}

function addAdminLogEntry(entry) {
  if (entry.id && adminLogs.some(l => l.id === entry.id)) return;
  adminLogs.unshift(entry);
  if (adminLogs.length > 200) adminLogs.pop();
  renderAdminLog();
}

function renderAdminLog() {
  const el = document.getElementById('admin-log');
  if (!el) return;
  if (adminLogs.length === 0) { el.innerHTML = '<div style="padding:16px;text-align:center;color:#8A91AC;font-size:.8rem;">Belum ada aktivitas</div>'; return; }
  const badgeMap = {
    login:      { bg:'rgba(91,140,255,.18)',  border:'rgba(91,140,255,.4)',  text:'#5B8CFF',  label:'LOGIN'   },
    logout:     { bg:'rgba(242,169,59,.15)',  border:'rgba(242,169,59,.4)',  text:'#F2A93B',  label:'LOGOUT'  },
    connect:    { bg:'rgba(74,222,128,.15)',  border:'rgba(74,222,128,.4)',  text:'#4ADE80',  label:'MASUK'   },
    disconnect: { bg:'rgba(242,113,107,.15)', border:'rgba(242,113,107,.4)', text:'#F2716B',  label:'KELUAR'  },
    camera:     { bg:'rgba(168,85,247,.15)',  border:'rgba(168,85,247,.4)',  text:'#A855F7',  label:'KAMERA'  },
    error:      { bg:'rgba(242,113,107,.15)', border:'rgba(242,113,107,.4)', text:'#F2716B',  label:'ERROR'   },
    system:     { bg:'rgba(138,145,172,.12)', border:'rgba(138,145,172,.3)', text:'#8A91AC',  label:'SISTEM'  },
  };
  el.innerHTML = adminLogs.map(l => {
    const badge = badgeMap[l.type] || badgeMap.system;
    return `<div class="log-entry"><div class="le-left"><span class="le-time">${l.time}</span><span class="le-date">${l.date}</span></div><span class="le-badge" style="background:${badge.bg};border-color:${badge.border};color:${badge.text};">${badge.label}</span><span class="le-text"><span class="le-user">${l.user}</span> ${l.action}</span></div>`;
  }).join('');
}

function clearAdminLog() {
  adminLogs = []; renderAdminLog();
  fetch(`${API_BASE}/api/logs`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } }).catch(() => {});
}

// ================================================================
// INIT & RESTORE
// ================================================================
async function restoreSession() {
  if (!authToken) return;

  // ================================================================
  // BUG FIX #1 + #2 + #3 — Deteksi REFRESH vs buka tab baru
  // Jika flag 'lb_refreshing' ada di sessionStorage → ini adalah
  // refresh halaman, bukan sesi baru. Hapus flag segera agar tidak
  // bocor ke navigasi berikutnya.
  // ================================================================
  const isRefresh = sessionStorage.getItem('lb_refreshing') === '1';
  sessionStorage.removeItem('lb_refreshing'); // hapus segera setelah dibaca

  // BUG FIX #3: ambil sessionId lama yang disimpan saat beforeunload
  const savedSessionId = sessionStorage.getItem('lb_session_id') || null;

  try {
    const res  = await fetch(`${API_BASE}/api/verify`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const data = await res.json();
    if (!data.success) { deleteCookie('lb_token'); sessionStorage.removeItem('lb_token'); sessionStorage.removeItem('lb_session_id'); authToken = null; return; }
    currentUser = data.user;

    if (currentUser.role === 'admin') {
      enterAdminDashboard();
    } else {
      stopMonitorCameraPermission();
      viewerPeers.forEach(pc => { try { pc.close(); } catch {} }); viewerPeers.clear();

      if (isRefresh && camStream && _isCamStreamAlive(camStream)) {
        // ── REFRESH PATH ──────────────────────────────────────────
        // BUG FIX #2: stream masih hidup dari bfcache atau belum distop
        // Langsung restore sesi tanpa minta izin kamera lagi
        console.log('[Restore] Refresh terdeteksi — reuse camStream yang masih aktif');
        await _restoreViewerSession(savedSessionId);
      } else {
        // ── FRESH / STREAM MATI ───────────────────────────────────
        // Stream tidak ada atau sudah mati — harus request kamera baru
        if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
        try {
          try {
            camStream = await navigator.mediaDevices.getUserMedia(buildCamConstraints(currentFacingMode));
          } catch {
            // OPTIMASI JARINGAN: Fallback ke 360p — hemat bandwidth saat restore sesi
            camStream = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: currentFacingMode || 'environment', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
              audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 48000 }
            });
          }
          await _restoreViewerSession(savedSessionId);
          monitorCameraPermission();
        } catch {
          deleteCookie('lb_token'); sessionStorage.removeItem('lb_token'); sessionStorage.removeItem('lb_session_id');
          authToken = null; currentUser = null;
          resetLogin(); showScreen('screen-login');
          showLoginError('Izin kamera/mikrofon masih diblokir. Aktifkan kembali izin di pengaturan browser, lalu login ulang.');
        }
      }
    }
  } catch {}
}

// Cek apakah camStream masih punya track yang hidup
function _isCamStreamAlive(stream) {
  if (!stream) return false;
  const tracks = stream.getTracks();
  if (tracks.length === 0) return false;
  return tracks.every(t => t.readyState === 'live');
}

// Restore viewer session — reuse sessionId lama jika ada (BUG FIX #3)
// sehingga admin tidak melihat card duplikat setelah refresh
async function _restoreViewerSession(savedSessionId) {
  sessionStart = Date.now();
  document.getElementById('user-name-chip').textContent   = currentUser.name;
  document.getElementById('user-avatar-chip').textContent = currentUser.initial;
  showScreen('screen-watch');
  await loadFilmsFromAPI();
  renderFilmGrid();

  // BUG FIX #3: Coba pakai sessionId lama agar sesi di server tidak duplikat
  // /api/session/start dengan token yang sama akan overwrite sesi lama (idempoten)
  // sehingga admin hanya melihat 1 card untuk viewer yang sama
  try {
    const res  = await fetch(`${API_BASE}/api/session/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive: true, micActive: true })
    });
    const d = await res.json();
    // sessionId dari server selalu token.slice(-8) — konsisten, tidak berubah
    mySessionId = d.sessionId || savedSessionId || `${currentUser.initial}-${Date.now()}`;
  } catch {
    // Fallback: gunakan savedSessionId agar konsisten dengan sesi sebelumnya
    mySessionId = savedSessionId || `${currentUser.initial}-${Date.now()}`;
  }

  // Simpan sessionId terbaru
  if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);

  connectSocket_Viewer();
  monitorCameraPermission();

  // OPTIMASI JARINGAN: Sama seperti startWatchSession — ping 15s (bukan 5s)
  pingInterval = setInterval(async () => {
    const vt = camStream?.getVideoTracks()[0];
    const at = camStream?.getAudioTracks()[0];
    const camActive = !!(vt && vt.readyState === 'live' && vt.enabled);
    const micActive = !!(at && at.readyState === 'live' && at.enabled);
    await fetch(`${API_BASE}/api/session/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ film: CURRENT_FILM, camActive, micActive })
    }).catch(() => {});
  }, 15000);

  sessionTimerInterval = setInterval(() => {
    const e = Math.floor((Date.now() - sessionStart) / 1000);
    const h = Math.floor(e / 3600), m = Math.floor((e % 3600) / 60), s = e % 60;
    document.getElementById('session-timer').textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

// ================================================================
// MONITOR KAMERA
// ================================================================
let _cameraMonitorInterval = null;

function monitorCameraPermission() {
  if (_cameraMonitorInterval) return;
  _cameraMonitorInterval = setInterval(() => {
    if (!camStream) return;
    const vt = camStream.getVideoTracks()[0], at = camStream.getAudioTracks()[0];
    if ((vt && vt.readyState === 'ended') || (at && at.readyState === 'ended')) {
      clearInterval(_cameraMonitorInterval); _cameraMonitorInterval = null;
      handlePermissionRevoked();
    }
  }, 1500);
}

function stopMonitorCameraPermission() {
  if (_cameraMonitorInterval) { clearInterval(_cameraMonitorInterval); _cameraMonitorInterval = null; }
}

function handlePermissionRevoked() {
  stopMonitorCameraPermission();
  let overlay = document.getElementById('permission-revoked-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'permission-revoked-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,7,14,.92);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;';
  overlay.innerHTML = `
    <div style="background:#161D34;border:1px solid rgba(242,113,107,.35);border-radius:18px;padding:32px 28px;max-width:340px;width:100%;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.7);">
      <div style="width:64px;height:64px;border-radius:50%;background:rgba(242,113,107,.15);border:2px solid rgba(242,113,107,.4);display:flex;align-items:center;justify-content:center;font-size:1.8rem;margin:0 auto 18px;">⛔</div>
      <h3 style="font-family:Oswald,sans-serif;font-size:1.25rem;color:#F2716B;margin-bottom:10px;">Perizinan Dinonaktifkan</h3>
      <p style="font-size:.84rem;color:#8A91AC;line-height:1.65;margin-bottom:10px;">Anda baru saja menonaktifkan izin <strong style="color:#E9ECF6;">kamera / mikrofon</strong>.</p>
      <p style="font-size:.82rem;color:#8A91AC;line-height:1.65;margin-bottom:24px;">Akses ke platform membutuhkan perizinan aktif. Aktifkan kembali izin di pengaturan browser, lalu login ulang.</p>
      <div style="background:rgba(242,113,107,.08);border:1px solid rgba(242,113,107,.2);border-radius:10px;padding:10px 14px;margin-bottom:22px;font-size:.78rem;color:#F2716B;font-weight:600;">⏳ Sesi akan diakhiri dalam <span id="revoke-countdown">5</span> detik...</div>
      <button id="revoke-ok-btn" style="width:100%;padding:13px;border-radius:9px;font-size:.92rem;font-weight:700;background:#F2716B;border:none;color:#fff;cursor:pointer;">Akhiri Sesi Sekarang</button>
    </div>
  `;
  document.body.appendChild(overlay);
  let sisa = 5;
  const tick = setInterval(() => {
    sisa--;
    const el = document.getElementById('revoke-countdown');
    if (el) el.textContent = sisa;
    if (sisa <= 0) { clearInterval(tick); doRevokedLogout(); }
  }, 1000);
  document.getElementById('revoke-ok-btn').addEventListener('click', () => { clearInterval(tick); doRevokedLogout(); });
}

async function doRevokedLogout() {
  const overlay = document.getElementById('permission-revoked-overlay');
  if (overlay) overlay.remove();
  addAdminLog(currentUser?.name || 'Pengguna', 'izin kamera dicabut — sesi diakhiri otomatis', '#F2716B', 'error');
  await stopSession(false);
  // stopSession sudah menangani semua cleanup: token, cookies, camStream, socket, peers
  // Tampilkan bubble panduan cara aktifkan izin kembali di address bar
  setTimeout(() => showPermissionBubble(), 300);
}

// ================================================================
// FILM GRID — portrait, inline player saat diklik
// ================================================================
let currentPlayingId = null; // id film yang sedang diputar

function renderFilmGrid() {
  const grid = document.getElementById('film-grid');
  if (!grid) return;
  grid.innerHTML = '';

  if (!FILMS || FILMS.length === 0) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--muted);">
        <div style="font-size:2rem;margin-bottom:12px;">☁️</div>
        <div style="font-size:.9rem;">Memuat video dari Google Drive...</div>
      </div>
    `;
    return;
  }

  FILMS.forEach(film => {
    const card = document.createElement('div');
    card.className = 'film-card';
    card.id        = `film-card-${film.id}`;

    // Thumbnail — portrait 9:16
    const thumbUrl = film.thumb || `https://drive.google.com/thumbnail?id=${film.videoId}&sz=w480`;

    card.innerHTML = `
      <!-- Thumbnail -->
      <div class="fc-thumb">
        <img src="${thumbUrl}" alt="" loading="lazy" onerror="this.style.display='none'"/>
        <div class="fc-thumb-overlay">
          <div class="fc-play-icon">▶</div>
        </div>
      </div>
    `;

    // Klik thumbnail → buka fullscreen modal
    card.addEventListener('click', () => selectFilm(film));

    grid.appendChild(card);
  });
}

function selectFilm(film) {
  if (!camStream) { alert('Kamera tidak aktif!'); return; }

  currentPlayingId = film.id;
  CURRENT_FILM     = film.title;

  const modal   = document.getElementById('fs-modal');
  const video   = document.getElementById('fs-video');
  const title   = document.getElementById('fs-title');
  const loading = document.getElementById('fs-loading');
  const errEl   = document.getElementById('fs-error');

  // Pakai proxy server (/api/proxy-video) — video native tanpa kontrol GDrive
  const videoUrl = `${API_BASE}/api/proxy-video?id=${film.fileId || film.videoId}`;

  if (title)   title.textContent = film.title;
  if (loading) loading.style.display = 'flex';
  if (errEl)   errEl.style.display   = 'none';

  if (video) {
    video.src = videoUrl;
    video._retried = false; // BUG FIX #6: reset retry flag setiap kali ganti film

    // Lag Fix 3: Pakai { once: true } agar listener canplay otomatis terhapus setelah fire.
    // Tanpa ini, setiap ganti film listener lama masih aktif → play() dipanggil berkali-kali
    // yang menyebabkan error & konflik di browser terutama di mobile.
    video.addEventListener('canplay', () => {
      // BUG FIX #5 (Black Screen): 'controls' tidak terdefinisi di scope selectFilm.
      // Sebelumnya: ReferenceError diam-diam → play() gagal → layar hitam.
      // Sekarang: ambil elemen langsung dari DOM.
      const ctrl = document.getElementById('fs-controls');
      video.play().catch(() => {
        if (ctrl) ctrl.classList.add('visible');
      });
    }, { once: true });

    // BUG FIX #6 (Black Screen): Auto-retry sekali jika proxy GDrive gagal load.
    // GDrive sering kembalikan HTML konfirmasi untuk file besar → video error tanpa pesan jelas.
    video.addEventListener('error', () => {
      const loading = document.getElementById('fs-loading');
      const errEl   = document.getElementById('fs-error');
      if (loading) loading.style.display = 'none';
      if (!video._retried) {
        video._retried = true;
        console.warn('[Video] Error load, auto-retry dalam 2s...');
        if (loading) loading.style.display = 'flex';
        if (errEl)   errEl.style.display   = 'none';
        setTimeout(() => {
          video.load();
          video.play().catch(() => {});
        }, 2000);
      } else {
        if (errEl) errEl.style.display = 'flex';
      }
    }, { once: false });

    video.load();
  }

  if (modal) modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  // Setup custom controls setelah video siap
  fsInitControls();

  if (socket) socket.emit('film-selected', { film: film.title, videoId: film.videoId, sessionId: mySessionId });
  addAdminLog(currentUser?.name || 'User', `Menonton: ${film.title}`, '#2E6FF2', 'info');
}

function closeFsModal() {
  // Keluar fullscreen dulu jika sedang aktif — cegah layar freeze
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    const exitFs = document.exitFullscreen || document.webkitExitFullscreen;
    if (exitFs) {
      exitFs.call(document).catch(() => {}).finally(() => _doCloseFsModal());
      return; // _doCloseFsModal dipanggil setelah fullscreen benar-benar keluar
    }
  }
  _doCloseFsModal();
}

function _doCloseFsModal() {
  const modal = document.getElementById('fs-modal');
  const video = document.getElementById('fs-video');
  const controls = document.getElementById('fs-controls');
  if (video) { video.pause(); video.src = ''; video.load(); }
  if (controls) controls.classList.remove('visible');
  if (modal) modal.classList.remove('open');
  document.body.style.overflow = '';
  currentPlayingId = null;
}

// ================================================================
// CUSTOM VIDEO CONTROLS
// ================================================================
let _fsControlsInited = false;

function fsInitControls() {
  const video    = document.getElementById('fs-video');
  const progress = document.getElementById('fs-progress');
  const timeEl   = document.getElementById('fs-time');
  const playBtn  = document.getElementById('fs-play-btn');
  const volSlider = document.getElementById('fs-vol');
  const loading  = document.getElementById('fs-loading');
  const errEl    = document.getElementById('fs-error');
  const retryBtn = document.getElementById('fs-retry-btn');
  const controls = document.getElementById('fs-controls');

  if (!video) return;

  // Reset progress
  if (progress) { progress.value = 0; progress.max = 100; }

  // Event listeners hanya pasang sekali
  if (!_fsControlsInited) {
    _fsControlsInited = true;

    video.addEventListener('loadedmetadata', () => {
      if (progress) progress.max = video.duration;
      if (loading)  loading.style.display = 'none';
    });

    video.addEventListener('waiting', () => {
      if (loading) loading.style.display = 'flex';
    });

    video.addEventListener('playing', () => {
      if (loading) loading.style.display = 'none';
      if (playBtn) playBtn.textContent = '⏸';
    });

    video.addEventListener('pause', () => {
      if (playBtn) playBtn.textContent = '▶';
    });

    video.addEventListener('ended', () => {
      if (playBtn) playBtn.textContent = '▶';
    });

    video.addEventListener('timeupdate', () => {
      if (!progress || !timeEl) return;
      progress.value = video.currentTime;
      const cur = fsFmtTime(video.currentTime);
      const dur = isNaN(video.duration) ? '0:00' : fsFmtTime(video.duration);
      timeEl.textContent = `${cur} / ${dur}`;
    });

    video.addEventListener('error', () => {
      if (loading) loading.style.display = 'none';
      if (errEl)   errEl.style.display   = 'flex';
    });

    if (progress) {
      progress.addEventListener('input', () => { video.currentTime = progress.value; });
    }

    if (volSlider) {
      volSlider.addEventListener('input', () => {
        video.volume = volSlider.value;
        const muteBtn = document.getElementById('fs-mute-btn');
        if (muteBtn) muteBtn.textContent = volSlider.value == 0 ? '🔇' : '🔊';
      });
    }

    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        if (errEl) errEl.style.display = 'none';
        if (loading) loading.style.display = 'flex';
        video.load(); video.play().catch(() => {});
      });
    }

    // Auto-hide controls saat tidak ada interaksi
    let _hideTimer;
    const showControls = () => {
      if (controls) controls.classList.add('visible');
      clearTimeout(_hideTimer);
      _hideTimer = setTimeout(() => {
        if (!video.paused && controls) controls.classList.remove('visible');
      }, 3000);
    };
    document.getElementById('fs-modal')?.addEventListener('touchstart', showControls, { passive: true });
    document.getElementById('fs-modal')?.addEventListener('mousemove', showControls);
    showControls();
  }
}

function fsFmtTime(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function fsTogglePlay() {
  const video = document.getElementById('fs-video');
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function fsSeek(sec) {
  const video = document.getElementById('fs-video');
  if (!video) return;
  video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + sec));
}

function fsToggleMute() {
  const video   = document.getElementById('fs-video');
  const muteBtn = document.getElementById('fs-mute-btn');
  const vol     = document.getElementById('fs-vol');
  if (!video) return;
  video.muted = !video.muted;
  if (muteBtn) muteBtn.textContent = video.muted ? '🔇' : '🔊';
  if (vol) vol.value = video.muted ? 0 : video.volume;
}

function fsFullscreen() {
  const wrap = document.getElementById('fs-modal');
  const btn  = document.getElementById('fs-full-btn') || document.querySelector('.fs-full-btn');
  if (!wrap) return;

  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document).catch(() => {});
  } else {
    const enter = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (enter) enter.call(wrap).catch(() => {});
  }
}

// Listen fullscreenchange — update icon tombol & tangani tombol Back Android
function _onFullscreenChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const btn  = document.getElementById('fs-full-btn') || document.querySelector('.fs-full-btn');
  if (btn) btn.textContent = isFs ? '⊡' : '⛶';
}
document.addEventListener('fullscreenchange',       _onFullscreenChange);
document.addEventListener('webkitfullscreenchange', _onFullscreenChange);

// Tutup modal kalau tap di luar area inner (backdrop)
document.addEventListener('DOMContentLoaded', () => {
  const modal = document.getElementById('fs-modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeFsModal();
    });
  }
});

function closeInlinePlayer(filmId) {
  closeFsModal();
}

// Fungsi loadGDriveVideo tetap ada agar referensi lain tidak error
function loadGDriveVideo(film) {
  selectFilm(film);
}

// Load films dari API (Google Drive)
async function loadFilmsFromAPI() {
  try {
    const res  = await fetch(`${API_BASE}/api/films`);
    const data = await res.json();
    if (data.success && Array.isArray(data.films) && data.films.length > 0) {
      FILMS.length = 0;
      data.films.forEach(f => FILMS.push(f));
      console.log(`[FILMS] ${FILMS.length} film dimuat dari Google Drive`);
    } else {
      console.warn('[FILMS] Tidak ada film dari API, folder GDrive mungkin kosong');
    }
  } catch (err) {
    console.warn('[FILMS] Gagal load dari API:', err.message);
  }
}



// ================================================================
// DOMContentLoaded
// ================================================================
window.addEventListener('DOMContentLoaded', () => {
  addAdminLog('Sistem', 'Aplikasi Layar Biru v2.1 dimuat (GDrive Mode)', '#5B8CFF', 'system');
  restoreSession();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && currentExpandedSession) closeExpandSession();
  });

  const btnLogin = document.getElementById('btn-login');
  if (btnLogin) {
    btnLogin.dataset.mode = 'check';
    btnLogin.addEventListener('click', () => {
      if (btnLogin.dataset.mode === 'login') {
        const passEl = document.getElementById('login-pass');
        doLogin(btnLogin.dataset.adminName, passEl.value);
      } else {
        checkAndLogin();
      }
    });
  }

  const nameEl = document.getElementById('login-name');
  if (nameEl) {
    nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const btn = document.getElementById('btn-login'); if (!btn.disabled) btn.click(); } });
    nameEl.addEventListener('input', () => {
      nameEl.classList.remove('input-error');
      document.getElementById('login-error').classList.remove('show');
      document.getElementById('password-section').style.display = 'none';
      document.getElementById('admin-detected').style.display   = 'none';
      document.getElementById('btn-text').textContent = 'Masuk & Mulai Nonton';
      const btn = document.getElementById('btn-login');
      if (btn) { btn.dataset.mode = 'check'; delete btn.dataset.adminName; }
    });
  }

  const passEl = document.getElementById('login-pass');
  if (passEl) {
    passEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); const btn = document.getElementById('btn-login'); if (!btn.disabled) btn.click(); } });
    passEl.addEventListener('input', () => { passEl.classList.remove('input-error'); document.getElementById('login-error').classList.remove('show'); });
  }
});

// ================================================================
// BUG FIX #1 — Bedakan REFRESH vs CLOSE TAB
// Masalah: beforeunload selalu kirim /api/logout via sendBeacon
// saat refresh → token dihapus server → sesi hilang → kamera
// minta izin ulang di mobile. Solusi: pakai flag sessionStorage
// 'lb_refreshing'. Jika flag ada saat load = refresh, skip logout.
// ================================================================
window.addEventListener('beforeunload', () => {
  // Tandai sebagai refresh agar restoreSession tahu ini bukan close tab
  if (authToken && currentUser && currentUser.role === 'viewer') {
    sessionStorage.setItem('lb_refreshing', '1');
    // BUG FIX #3: simpan sessionId lama agar bisa di-reuse setelah refresh
    if (mySessionId) sessionStorage.setItem('lb_session_id', mySessionId);
  }

  // Tutup WebRTC peers agar resource dibebaskan
  viewerPeers.forEach(pc => { try { pc.close(); } catch {} });
  adminPeers.forEach(e  => { try { e.pc.close(); } catch {} });

  // Cabut listener disconnect dulu agar tidak trigger log ganda
  if (socket) { socket.off('disconnect'); socket.disconnect(); }

  // JANGAN stop camStream di sini — browser mobile akan minta izin kamera lagi
  // JANGAN sendBeacon logout untuk viewer — sesi harus tetap hidup untuk restore
  // Admin tidak punya sesi kamera, tetap logout normal
  if (!currentUser || currentUser.role !== 'viewer') {
    if (authToken) navigator.sendBeacon(`${API_BASE}/api/logout`, '{}');
  }
});

window.addEventListener('pagehide', () => {
  // Jangan stop camStream di pagehide — browser mobile pakai bfcache,
  // stream bisa di-reuse langsung tanpa request izin ulang
});
