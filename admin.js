/* ==========================================================================
   FILE 2 / 3: admin.js
   Berisi: dashboard admin (player online, permintaan pembayaran, atur
   harga & diskon), login admin, dan beberapa fungsi bantu terkait folder.
   PENTING: file ini harus dimuat SETELAH core.js dan SEBELUM app.js.
   ========================================================================== */

function requestFolderAccess(folder){
  path = [...path, { id: folder.id, name: folder.name, createdTime: folder.createdTime }];
  loadCurrentFolder();
}

const adminPwModal = document.getElementById('adminPwModal');
const adminPwInput = document.getElementById('adminPwInput');
const adminPwError = document.getElementById('adminPwError');
const adminPwSubmitBtn = document.getElementById('adminPwSubmitBtn');
const adminDashboard = document.getElementById('adminDashboard');
const adminPlayerList = document.getElementById('adminPlayerList');
const adminStatusText = document.getElementById('adminStatusText');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');
const adminRequestsList = document.getElementById('adminRequestsList');
const adminRequestsStatusText = document.getElementById('adminRequestsStatusText');
const statOnlineNum = document.getElementById('statOnlineNum');
const statPendingNum = document.getElementById('statPendingNum');
const statPendingChip = document.getElementById('statPendingChip');
const reqSubtabs = document.getElementById('reqSubtabs');
const reqPendingBadge = document.getElementById('reqPendingBadge');
const reqSearchInput = document.getElementById('reqSearchInput');
let reqFilter = 'pending';
let reqSearchTerm = '';
let adminPollInterval = null;

function timeAgo(ts){
  const s = Math.floor((Date.now() - ts) / 1000);
  if(s < 5) return 'baru saja';
  if(s < 60) return `${s} detik lalu`;
  const m = Math.floor(s / 60);
  if(m < 60) return `${m} menit lalu`;
  const h = Math.floor(m / 60);
  if(h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if(d < 7) return `${d} hari lalu`;
  // Lebih dari seminggu -> tampilkan tanggal & jam pastinya, bukan "X hari lalu".
  const dt = new Date(ts);
  const tgl = dt.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  const jam = dt.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  return `${tgl}, ${jam}`;
}

let onlinePlayersCache = [];

function folderOptionsHtml(){
  let opts = '<option value="">Pilih folder untuk dibuka...</option>';
  if(ALL_ACCESS_ENABLED){
    opts += `<option value="${ALL_ACCESS_ID}">🔓 ${ALL_ACCESS_NAME}</option>`;
  }
  (allDriveFoldersCache || []).forEach(f => {
    opts += `<option value="${f.id}">${f.name}</option>`;
  });
  return opts;
}

async function renderAdminDashboard(){
  const data = await fetchActivePlayers();
  if(data === null){
    adminStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminPlayerList.innerHTML = '';
    return;
  }
  // fetchActivePlayers sudah memfilter berdasarkan last_seen >= cutoff di server,
  // jadi semua entry di sini dijamin masih aktif — tidak perlu filter ulang di client.
  // Dedupe berdasarkan nama: kalau ada beberapa session_id untuk nama yang sama
  // (misalnya karena localStorage sempat ke-reset di HP pengunjung), cuma
  // tampilkan satu entri per nama, yaitu yang lastSeen-nya paling baru.
  const latestByName = new Map();
  let online = Object.values(data);
  online.forEach(p => {
    const existing = latestByName.get(p.name);
    if(!existing || p.lastSeen > existing.lastSeen){
      latestByName.set(p.name, p);
    }
  });
  online = Array.from(latestByName.values());
  online.sort((a, b) => b.lastSeen - a.lastSeen);
  onlinePlayersCache = online;
  adminStatusText.textContent = `${online.length} player sedang online`;
  if(statOnlineNum) statOnlineNum.textContent = online.length;
  if(!online.length){
    adminPlayerList.innerHTML = `<div style="color:var(--text-dim); font-size:13px;">Belum ada player online.</div>`;
    return;
  }
  // Folder mungkin belum pernah dimuat kalau admin belum buka bagian "Harga Akses".
  if(allDriveFoldersCache === null){
    allDriveFoldersCache = await fetchAllDriveFoldersRecursive(ROOT_FOLDER_ID);
  }
  const optionsHtml = folderOptionsHtml();
  adminPlayerList.innerHTML = online.map((p, i) => `
    <div class="player-item">
      <div class="player-item-top">
        <span class="pname"><span class="pdot"></span>${escapeHtml(p.name)}</span>
        <span class="ptime">${timeAgo(p.lastSeen)}</span>
      </div>
      <div class="player-grant-row">
        <select class="player-folder-select" data-idx="${i}">${optionsHtml}</select>
        <button class="player-grant-btn" data-action="grant-access" data-idx="${i}">Buka Akses</button>
      </div>
    </div>
  `).join('');
}

// Admin membuka akses folder tertentu untuk pengunjung yang sedang online,
// tanpa perlu pengunjung mengirim bukti transfer sama sekali.
async function grantFolderAccess(player, folderId, btn){
  const isAllAccess = folderId === ALL_ACCESS_ID;
  const folderName = isAllAccess
    ? ALL_ACCESS_NAME
    : ((allDriveFoldersCache || []).find(f => f.id === folderId)?.name || 'Folder');
  if(!confirm(`Buka akses "${folderName}" untuk ${player.name} sekarang, tanpa bukti transfer?`)) return;

  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Membuka...';

  const key = requestKey(player.name, folderId);
  const ok = await upsertPaymentRequest(key, {
    name: player.name,
    folderId,
    folderName,
    price: folderPrice(folderId),
    status: 'approved',
    proofUrl: null,
    requestedAt: Date.now(),
    updatedAt: Date.now()
  });

  btn.disabled = false;
  btn.textContent = originalLabel;

  if(ok){
    adminRequestsStatusText.textContent = `Akses "${folderName}" untuk ${player.name} berhasil dibuka ✓`;
    renderAdminRequests();
  } else {
    alert('Gagal membuka akses. Coba lagi.');
  }
}

adminPlayerList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="grant-access"]');
  if(!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  const player = onlinePlayersCache[idx];
  if(!player) return;
  const row = btn.closest('.player-item');
  const select = row.querySelector('.player-folder-select');
  const folderId = select.value;
  if(!folderId){
    select.focus();
    return;
  }
  grantFolderAccess(player, folderId, btn);
});

/* ====== ADMIN: PERMINTAAN PEMBAYARAN ====== */
async function renderAdminRequests(){
  const data = await fetchPaymentRequests();
  if(data === null){
    adminRequestsStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminRequestsList.innerHTML = '';
    return;
  }
  const entries = Object.entries(data).map(([key, v]) => ({ key, ...v }));
  const term = (reqSearchTerm || '').trim().toLowerCase();
  const matchesTerm = e => !term || (e.name||'').toLowerCase().includes(term) || (e.folderName||'').toLowerCase().includes(term);

  const pendingAll = entries.filter(e => e.status === 'pending').sort((a,b) => b.requestedAt - a.requestedAt);
  const historyAll = entries.filter(e => e.status !== 'pending').sort((a,b) => (b.updatedAt||b.requestedAt) - (a.updatedAt||a.requestedAt));

  // Update badge/chip global (selalu berdasarkan jumlah pending sesungguhnya, bukan hasil filter pencarian)
  updateAdminTabBadge('requests', pendingAll.length);
  if(reqPendingBadge){
    if(pendingAll.length > 0){
      reqPendingBadge.style.display = 'inline-flex';
      reqPendingBadge.textContent = pendingAll.length;
    } else {
      reqPendingBadge.style.display = 'none';
    }
  }
  if(statPendingNum) statPendingNum.textContent = pendingAll.length;
  if(statPendingChip) statPendingChip.classList.toggle('zero', pendingAll.length === 0);

  const pending = pendingAll.filter(matchesTerm);
  const history = historyAll.filter(matchesTerm).slice(0, 30);
  const ordered = reqFilter === 'pending' ? pending : history;

  if(reqFilter === 'pending'){
    adminRequestsStatusText.textContent = term
      ? `${pending.length} dari ${pendingAll.length} permintaan pending cocok dengan "${term}"`
      : `${pendingAll.length} permintaan menunggu konfirmasi`;
  } else {
    adminRequestsStatusText.textContent = term
      ? `Menampilkan ${history.length} riwayat cocok dengan "${term}"`
      : `Menampilkan ${history.length} riwayat terakhir`;
  }

  if(!ordered.length){
    const emptyMsg = reqFilter === 'pending'
      ? (term ? 'Tidak ada permintaan pending yang cocok.' : 'Belum ada permintaan pembayaran.')
      : (term ? 'Tidak ada riwayat yang cocok.' : 'Belum ada riwayat.');
    adminRequestsList.innerHTML = `<div class="req-empty">${emptyMsg}</div>`;
    return;
  }

  adminRequestsList.innerHTML = ordered.map(e => {
    // Validasi proofUrl: hanya izinkan URL https:// untuk mencegah javascript: injection
    const safeProofUrl = e.proofUrl && e.proofUrl.startsWith('https://') ? e.proofUrl : null;
    const proofHtml = safeProofUrl
      ? `<a href="${escapeHtml(safeProofUrl)}" target="_blank" rel="noopener" class="rproof"><img src="${escapeHtml(safeProofUrl)}" alt="Bukti transfer" loading="lazy"></a>`
      : `<div class="rproof rproof-missing">Tanpa foto</div>`;

    if(e.status === 'pending'){
      return `
        <div class="request-item pending">
          <div class="req-top">
            ${proofHtml}
            <div class="rinfo">
              <div class="rname-row">
                <span class="rname">${escapeHtml(e.name)}</span>
                <span class="ramount">${formatRupiah(e.price)}</span>
              </div>
              <div class="rfolder">${escapeHtml(e.folderName)}</div>
              <div class="rtime">${timeAgo(e.requestedAt)}</div>
            </div>
          </div>
          <div class="ractions ractions-pending">
            <button class="rbtn approve" data-action="approve" data-key="${escapeHtml(e.key)}">✓ Setujui</button>
            <button class="rbtn reject" data-action="reject" data-key="${escapeHtml(e.key)}">✕ Tolak</button>
            <button class="rbtn delete icon-only" data-action="delete" data-key="${escapeHtml(e.key)}" title="Hapus" aria-label="Hapus">🗑</button>
          </div>
        </div>`;
    }

    const badgeHtml = e.status === 'approved'
      ? `<span class="rbadge approved">Disetujui</span>`
      : `<span class="rbadge rejected">Ditolak</span>`;
    return `
      <div class="request-item history ${e.status}">
        ${proofHtml}
        <div class="rinfo">
          <div class="rname">${escapeHtml(e.name)}</div>
          <div class="rfolder">${escapeHtml(e.folderName)} · ${formatRupiah(e.price)}</div>
          <div class="rtime">${timeAgo(e.updatedAt || e.requestedAt)}</div>
        </div>
        <div class="ractions">
          ${badgeHtml}
          <button class="rbtn delete icon-only" data-action="delete" data-key="${escapeHtml(e.key)}" title="Hapus riwayat" aria-label="Hapus riwayat">🗑</button>
        </div>
      </div>`;
  }).join('');
}

if(reqSubtabs){
  reqSubtabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.req-subtab-btn');
    if(!btn) return;
    reqFilter = btn.dataset.filter;
    reqSubtabs.querySelectorAll('.req-subtab-btn').forEach(b => b.classList.toggle('active', b === btn));
    renderAdminRequests();
  });
}
if(reqSearchInput){
  reqSearchInput.addEventListener('input', () => {
    reqSearchTerm = reqSearchInput.value;
    renderAdminRequests();
  });
}

async function updateRequestStatus(key, status){
  await setPaymentRequestStatus(key, status);
  renderAdminRequests();
}

async function removeRequest(key){
  if(!confirm('Hapus riwayat permintaan pembayaran ini? Tindakan ini tidak bisa dibatalkan.')) return;
  const ok = await deletePaymentRequest(key);
  if(!ok){
    alert('Gagal menghapus. Kemungkinan besar policy "delete" untuk tabel payment_requests belum diaktifkan di Supabase. Lihat catatan di bagian atas script.js untuk SQL perbaikannya.');
    return;
  }
  renderAdminRequests();
}

async function removeAllRequests(){
  if(!confirm('Hapus SEMUA riwayat permintaan pembayaran (termasuk yang masih pending)? Tindakan ini tidak bisa dibatalkan.')) return;
  const result = await deleteAllPaymentRequests();
  if(result === false){
    alert('Gagal menghapus. Kemungkinan besar policy "delete" untuk tabel payment_requests belum diaktifkan di Supabase. Lihat catatan di bagian atas script.js untuk SQL perbaikannya.');
    return;
  }
  renderAdminRequests();
}

adminRequestsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.rbtn');
  if(!btn) return;
  const key = btn.dataset.key;
  const action = btn.dataset.action;
  if(action === 'delete'){
    removeRequest(key);
  } else {
    updateRequestStatus(key, action === 'approve' ? 'approved' : 'rejected');
  }
});

const adminRequestsDeleteAllBtn = document.getElementById('adminRequestsDeleteAllBtn');
if(adminRequestsDeleteAllBtn){
  adminRequestsDeleteAllBtn.addEventListener('click', removeAllRequests);
}

const adminPricesRefreshBtn = document.getElementById('adminPricesRefreshBtn');
adminPricesRefreshBtn.addEventListener('click', () => renderAdminPrices(true));

const adminPricesList = document.getElementById('adminPricesList');
const adminPricesStatusText = document.getElementById('adminPricesStatusText');
const adminAllAccessPriceWrap = document.getElementById('adminAllAccessPriceWrap');

const adminDiscountWrap = document.getElementById('adminDiscountWrap');

function renderAdminDiscount(){
  if(!adminDiscountWrap) return;
  const pct = discountPercentCache || 0;
  const statusHtml = pct > 0
    ? `<span class="pfree">Diskon ${pct}% sedang aktif untuk semua folder berbayar (berlaku terus sampai diubah manual).</span>`
    : '';
  adminDiscountWrap.innerHTML = `
    <div class="price-item all-access-item" data-action-wrap="discount">
      <div class="pname">Diskon Semua Harga <span class="pfree">(otomatis potong harga tiap folder, tidak berlaku untuk "Akses Semua Folder")</span></div>
      <div class="pinput-row">
        <input type="number" class="pinput" id="adminDiscountInput" min="0" max="100" step="1" value="${pct}">
        <span class="pprefix">%</span>
        <button class="pbtn" id="adminDiscountSaveBtn">Simpan</button>
      </div>
      <span class="psaved" id="adminDiscountSaved" style="display:none;">Tersimpan ✓</span>
      ${statusHtml ? `<div style="margin-top:8px;">${statusHtml}</div>` : ''}
    </div>`;
  const saveBtn = document.getElementById('adminDiscountSaveBtn');
  const input = document.getElementById('adminDiscountInput');
  if(saveBtn){
    saveBtn.addEventListener('click', async () => {
      const value = parseFloat(input.value);
      if(isNaN(value) || value < 0 || value > 100){
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Menyimpan...';
      const ok = await saveDiscountPercent(value);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Simpan';
      if(ok){
        adminPricesStatusText.textContent = value > 0
          ? `Diskon ${value}% tersimpan dan langsung diterapkan ke semua harga ✓`
          : 'Diskon dinonaktifkan ✓';
        renderAdminPrices(false);
        renderAdminDiscount();
      } else {
        adminPricesStatusText.textContent = 'Gagal menyimpan diskon. Coba lagi.';
      }
    });
  }
}

function renderAdminAllAccessPrice(){
  if(!adminAllAccessPriceWrap) return;
  const original = basePrice(ALL_ACCESS_ID);
  adminAllAccessPriceWrap.innerHTML = `
    <div class="price-item all-access-item" data-folder-id="${ALL_ACCESS_ID}" data-folder-name="${ALL_ACCESS_NAME}">
      <div class="pname">${ALL_ACCESS_NAME} <span class="pfree">(bayar sekali, buka semua folder berbayar &middot; tidak terkena diskon)</span></div>
      <div class="pinput-row">
        <span class="pprefix">Rp</span>
        <input type="number" class="pinput" min="0" step="1000" value="${original}">
        <button class="pbtn" data-action="save-price">Simpan</button>
      </div>
      <span class="psaved" style="display:none;">Tersimpan ✓</span>
    </div>`;
}

if(adminAllAccessPriceWrap){
  adminAllAccessPriceWrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('.pbtn[data-action="save-price"]');
    if(!btn) return;
    const item = btn.closest('.price-item');
    const folderId = item.dataset.folderId;
    const folderName = item.dataset.folderName;
    const input = item.querySelector('.pinput');
    const price = parseInt(input.value, 10);
    if(isNaN(price) || price < 0){
      input.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Menyimpan...';
    const ok = await saveFolderPrice(folderId, folderName, price);
    if(ok){
      btn.textContent = 'Simpan';
      btn.disabled = false;
      adminPricesStatusText.textContent = 'Harga akses semua folder tersimpan ✓';
    } else {
      btn.disabled = false;
      btn.textContent = 'Simpan';
      adminPricesStatusText.textContent = 'Gagal menyimpan harga. Coba lagi.';
    }
  });
}

async function fetchAllDriveFoldersRecursive(rootId){
  const result = [];
  const queue = [rootId];
  const seen = new Set();
  while(queue.length){
    const parentId = queue.shift();
    if(seen.has(parentId)) continue;
    seen.add(parentId);
    const query = encodeURIComponent(
      `'${parentId}' in parents and trashed = false and mimeType = 'application/vnd.google-apps.folder'`
    );
    const fields = encodeURIComponent('files(id,name)');
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=name&pageSize=200&key=${API_KEY}`;
    try{
      const res = await fetch(url);
      const data = await res.json();
      const folders = data.files || [];
      folders.forEach(f => {
        result.push(f);
        queue.push(f.id);
      });
    }catch(e){  }
  }
  return result;
}

let allDriveFoldersCache = null;

async function renderAdminPrices(forceReload){
  if(!dbReady()){
    adminPricesStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminPricesList.innerHTML = '';
    return;
  }
  if(forceReload || allDriveFoldersCache === null){
    adminPricesStatusText.textContent = 'Memuat daftar folder dari Google Drive...';
    adminPricesList.innerHTML = '';
    allDriveFoldersCache = await fetchAllDriveFoldersRecursive(ROOT_FOLDER_ID);
  }
  await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);
  renderAdminDiscount();
  renderAdminAllAccessPrice();

  if(!allDriveFoldersCache.length){
    adminPricesStatusText.textContent = 'Tidak ada folder ditemukan di Google Drive.';
    adminPricesList.innerHTML = '';
    return;
  }

  const pct = discountPercentCache || 0;
  const discountLive = isDiscountActive();
  adminPricesStatusText.textContent = discountLive
    ? `${allDriveFoldersCache.length} folder ditemukan. Diskon ${pct}% sedang aktif, harga di bawah sudah termasuk potongan. Set harga ke 0 untuk membuat folder gratis.`
    : `${allDriveFoldersCache.length} folder ditemukan. Set harga ke 0 untuk membuat folder gratis. Ubah harga lalu tekan Simpan.`;
  adminPricesList.innerHTML = allDriveFoldersCache.map(f => {
    const original = basePrice(f.id);
    const price = folderPrice(f.id);
    const hardcodedFree = FREE_FOLDER_IDS.includes(f.id);
    const isFreeNow = hardcodedFree || original === 0;
    const discountBadge = (discountLive && !isFreeNow)
      ? ` <span class="pfree">(harga asli ${formatRupiah(original)}, setelah diskon ${formatRupiah(price)})</span>`
      : '';
    return `
      <div class="price-item" data-folder-id="${f.id}" data-folder-name="${f.name.replace(/"/g,'&quot;')}">
        <div class="pname" title="${f.name}">${f.name}${isFreeNow ? ' <span class="pfree">(gratis)</span>' : discountBadge}</div>
        <div class="pinput-row">
          <span class="pprefix">Rp</span>
          <input type="number" class="pinput" min="0" step="1000" value="${original}" ${hardcodedFree ? 'disabled' : ''}>
          <button class="pbtn" data-action="save-price" ${hardcodedFree ? 'disabled' : ''}>Simpan</button>
        </div>
        <span class="psaved" style="display:none;">Tersimpan ✓</span>
      </div>`;
  }).join('');
}

adminPricesList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.pbtn[data-action="save-price"]');
  if(!btn) return;
  const item = btn.closest('.price-item');
  const folderId = item.dataset.folderId;
  const folderName = item.dataset.folderName;
  const input = item.querySelector('.pinput');
  const price = parseInt(input.value, 10);
  if(isNaN(price) || price < 0){
    input.focus();
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Menyimpan...';
  const ok = await saveFolderPrice(folderId, folderName, price);
  if(ok){
    adminPricesStatusText.textContent = 'Tersimpan ✓';
    renderAdminPrices(false);
  } else {
    btn.disabled = false;
    btn.textContent = 'Simpan';
    adminPricesStatusText.textContent = 'Gagal menyimpan harga. Coba lagi.';
  }
});

function openAdminDashboard(){
  adminPwModal.classList.remove('active');
  gateOverlay.style.display = 'none';
  adminDashboard.style.display = 'flex';
  initAdminTabsOnce();
  renderAdminDashboard();
  renderAdminRequests();
  renderAdminPrices();
  renderAdminNotifications();
  renderAdminTestimonials();
  renderAssetVersionStatus();
  if(adminPollInterval) clearInterval(adminPollInterval);
  adminPollInterval = setInterval(() => { renderAdminDashboard(); renderAdminRequests(); }, 5000);
}

// ===== Tab Notifikasi: kirim pemberitahuan baru & kelola riwayat =====
const adminNotifTitleInput = document.getElementById('adminNotifTitleInput');
const adminNotifMessageInput = document.getElementById('adminNotifMessageInput');
const adminNotifError = document.getElementById('adminNotifError');
const adminNotifSendBtn = document.getElementById('adminNotifSendBtn');
const adminNotifStatusText = document.getElementById('adminNotifStatusText');
const adminNotifList = document.getElementById('adminNotifList');
const adminNotifRefreshBtn = document.getElementById('adminNotifRefreshBtn');

async function renderAdminNotifications(){
  if(!dbReady()){
    adminNotifStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminNotifList.innerHTML = '';
    return;
  }
  adminNotifStatusText.textContent = 'Memuat...';
  const list = await fetchNotifications();
  if(!list){
    adminNotifStatusText.textContent = 'Gagal memuat riwayat pemberitahuan.';
    adminNotifList.innerHTML = '';
    return;
  }
  if(!list.length){
    adminNotifStatusText.textContent = 'Belum ada pemberitahuan yang dikirim.';
    adminNotifList.innerHTML = '';
    return;
  }
  adminNotifStatusText.textContent = `${list.length} pemberitahuan terkirim.`;
  adminNotifList.innerHTML = list.map(n => `
    <div class="player-item" data-notif-id="${n.id}">
      <div class="player-item-top">
        <span class="pname">${escapeHtml(n.title)}</span>
        <button class="pbtn-refresh pbtn-danger notif-delete-btn" data-notif-id="${n.id}" title="Hapus pemberitahuan ini">Hapus</button>
      </div>
      <div class="notif-message" style="margin:6px 0;">${escapeHtml(n.message)}</div>
      <span style="color:var(--text-dim); font-size:11px;">${timeAgo(new Date(n.created_at).getTime())}</span>
    </div>
  `).join('');
}

adminNotifSendBtn.addEventListener('click', async () => {
  const title = adminNotifTitleInput.value.trim();
  const message = adminNotifMessageInput.value.trim();
  adminNotifError.textContent = '';
  if(!title || !message){
    adminNotifError.textContent = 'Judul dan isi pesan tidak boleh kosong.';
    return;
  }
  adminNotifSendBtn.disabled = true;
  adminNotifSendBtn.textContent = 'Mengirim...';
  const ok = await sendNotificationDb(title, message);
  adminNotifSendBtn.disabled = false;
  adminNotifSendBtn.textContent = 'Kirim Pemberitahuan';
  if(ok){
    adminNotifTitleInput.value = '';
    adminNotifMessageInput.value = '';
    renderAdminNotifications();
  } else {
    adminNotifError.textContent = 'Gagal mengirim pemberitahuan. Coba lagi.';
  }
});

adminNotifRefreshBtn.addEventListener('click', () => renderAdminNotifications());

adminNotifList.addEventListener('click', async (e) => {
  const btn = e.target.closest('.notif-delete-btn');
  if(!btn) return;
  const id = btn.dataset.notifId;
  if(!confirm('Hapus pemberitahuan ini? Pengguna yang belum sempat membaca tidak akan melihatnya lagi.')) return;
  btn.disabled = true;
  btn.textContent = 'Menghapus...';
  const ok = await deleteNotificationDb(id);
  if(ok){
    renderAdminNotifications();
  } else {
    btn.disabled = false;
    btn.textContent = 'Hapus';
  }
});

// ===== Tab Testimoni: moderasi testimoni yang dikirim pengguna =====
const adminTestiStatusText = document.getElementById('adminTestiStatusText');
const adminTestiList = document.getElementById('adminTestiList');
const adminTestiRefreshBtn = document.getElementById('adminTestiRefreshBtn');

async function renderAdminTestimonials(){
  if(!adminTestiList) return;
  if(!dbReady()){
    adminTestiStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    adminTestiList.innerHTML = '';
    return;
  }
  adminTestiStatusText.textContent = 'Memuat...';
  const list = await fetchTestimonials();
  if(!list){
    adminTestiStatusText.textContent = 'Gagal memuat testimoni.';
    adminTestiList.innerHTML = '';
    return;
  }
  if(!list.length){
    adminTestiStatusText.textContent = 'Belum ada testimoni dari pengguna.';
    adminTestiList.innerHTML = '';
    return;
  }
  adminTestiStatusText.textContent = `${list.length} testimoni.`;
  adminTestiList.innerHTML = list.map(t => `
    <div class="player-item" data-testi-id="${t.id}">
      <div class="player-item-top">
        <span class="pname">${escapeHtml(t.name)}</span>
        <button class="pbtn-refresh pbtn-danger testi-delete-btn" data-testi-id="${t.id}" title="Hapus testimoni ini">Hapus</button>
      </div>
      <div class="notif-message" style="margin:6px 0;">${escapeHtml(t.message)}</div>
      <span style="color:var(--text-dim); font-size:11px;">${timeAgo(new Date(t.created_at).getTime())}</span>
    </div>
  `).join('');
}

if(adminTestiRefreshBtn) adminTestiRefreshBtn.addEventListener('click', () => renderAdminTestimonials());

if(adminTestiList){
  adminTestiList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.testi-delete-btn');
    if(!btn) return;
    const id = btn.dataset.testiId;
    if(!confirm('Hapus testimoni ini secara permanen?')) return;
    btn.disabled = true;
    btn.textContent = 'Menghapus...';
    const ok = await deleteTestimonialDb(id);
    if(ok){
      renderAdminTestimonials();
    } else {
      btn.disabled = false;
      btn.textContent = 'Hapus';
    }
  });
}

// Navigasi tab dashboard admin, supaya tiap bagian (Player Online,
// Pembayaran, Harga) tidak perlu di-scroll semua sekaligus.
let adminTabsInitialized = false;
function switchAdminTab(tabName){
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.admin-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === 'adminTab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  });
  setCookie('adminLastTab', tabName, ADMIN_SESSION_HOURS);
}
function initAdminTabsOnce(){
  if(adminTabsInitialized) return;
  adminTabsInitialized = true;
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
  });
  const lastTab = getCookie('adminLastTab') || 'players';
  switchAdminTab(lastTab);
}

// Tampilkan angka kecil di tab (mis. jumlah permintaan pembayaran yang
// masih pending) supaya admin langsung tahu tanpa harus buka tabnya dulu.
function updateAdminTabBadge(tabName, count){
  const btn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  if(!btn) return;
  let badge = btn.querySelector('.tab-count-badge');
  if(count > 0){
    if(!badge){
      badge = document.createElement('span');
      badge.className = 'tab-count-badge';
      btn.appendChild(badge);
    }
    badge.textContent = count;
  } else if(badge){
    badge.remove();
  }
}

// Login admin sekarang divalidasi di server lewat Supabase RPC (admin_login).
// Server yang menyimpan hash password asli (di tabel admin_config yang
// tidak bisa dibaca oleh anon key) dan yang membuat token sesi acak.
// Client tidak pernah tahu hash aslinya, jadi tidak bisa dipalsukan lagi
// hanya dengan baca source code.
async function submitAdminPassword(){
  if(!dbReady()){
    adminPwError.textContent = 'Supabase belum dikonfigurasi.';
    return;
  }
  adminPwSubmitBtn.disabled = true;
  adminPwSubmitBtn.textContent = 'Memeriksa...';
  const enteredHash = await sha256Hex(adminPwInput.value);
  let token = null;
  try{
    const { data, error } = await sb.rpc('admin_login', { input_password_hash: enteredHash });
    if(!error) token = data;
  }catch(e){ token = null; }
  adminPwSubmitBtn.disabled = false;
  adminPwSubmitBtn.textContent = 'Masuk';
  if(token){
    setCookie('adminSession', token, ADMIN_SESSION_HOURS);
    openAdminDashboard();
  } else {
    adminPwError.textContent = 'Password salah, coba lagi.';
    adminPwInput.value = '';
    adminPwInput.focus();
  }
}
adminPwSubmitBtn.addEventListener('click', submitAdminPassword);
adminPwInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitAdminPassword(); });
adminPwModal.addEventListener('click', (e) => { if(e.target === adminPwModal) { adminPwModal.classList.remove('active'); gateOverlay.style.display = 'flex'; } });

async function adminLogout(){
  if(adminPollInterval) clearInterval(adminPollInterval);
  const token = getCookie('adminSession');
  setCookie('adminSession', '', -1);
  if(token && dbReady()){
    try{ await sb.rpc('admin_logout', { input_token: token }); }catch(e){}
  }
  adminDashboard.style.display = 'none';
  gateOverlay.style.display = 'flex';
  gateNameInput.value = '';
  setTimeout(() => gateNameInput.focus(), 50);
}
adminLogoutBtn.addEventListener('click', adminLogout);
const adminHeaderLogoutBtn = document.getElementById('adminHeaderLogoutBtn');
if(adminHeaderLogoutBtn) adminHeaderLogoutBtn.addEventListener('click', adminLogout);

// ===== Tab Cache: perbarui versi CSS/JS supaya browser pengguna ambil yang terbaru =====
const adminRefreshAssetsBtn = document.getElementById('adminRefreshAssetsBtn');
const adminAssetVersionStatusText = document.getElementById('adminAssetVersionStatusText');
const adminAssetVersionError = document.getElementById('adminAssetVersionError');

async function renderAssetVersionStatus(){
  if(!adminAssetVersionStatusText) return;
  if(!dbReady()){
    adminAssetVersionStatusText.textContent = 'Belum dikonfigurasi. Isi SUPABASE_URL dan SUPABASE_ANON_KEY di bagian atas skrip.';
    return;
  }
  const v = await fetchAssetVersion();
  adminAssetVersionStatusText.textContent = v
    ? `Versi cache saat ini: ${v}.`
    : 'Belum pernah diperbarui — situs masih pakai versi bawaan.';
}

if(adminRefreshAssetsBtn){
  adminRefreshAssetsBtn.addEventListener('click', async () => {
    if(!dbReady()){
      adminAssetVersionError.textContent = 'Supabase belum dikonfigurasi.';
      return;
    }
    adminAssetVersionError.textContent = '';
    adminRefreshAssetsBtn.disabled = true;
    adminRefreshAssetsBtn.textContent = 'Memperbarui...';

    const newVersion = Date.now();
    const ok = await saveAssetVersion(newVersion);

    adminRefreshAssetsBtn.disabled = false;
    adminRefreshAssetsBtn.textContent = '🔄 Perbarui Cache Sekarang';

    if(ok){
      adminAssetVersionStatusText.textContent = `Versi cache berhasil diperbarui ✓ (${newVersion})`;
    } else {
      adminAssetVersionError.textContent = 'Gagal memperbarui versi cache. Coba lagi.';
    }
  });
}



// Kalau ada sesi admin yang masih berlaku (cookie belum expired, maks 2 jam),
// langsung buka dashboard tanpa minta password lagi.
// Token sesi divalidasi lewat RPC admin_check_session di server, bukan
// dengan dibandingkan ke konstanta publik seperti sebelumnya.
async function restoreAdminSessionIfValid(){
  const existingAdminSession = getCookie('adminSession');
  if(!existingAdminSession || !dbReady()) return;
  try{
    const { data, error } = await sb.rpc('admin_check_session', { input_token: existingAdminSession });
    if(!error && data === true){
      openAdminDashboard();
    } else {
      setCookie('adminSession', '', -1);
    }
  }catch(e){
    setCookie('adminSession', '', -1);
  }
}
restoreAdminSessionIfValid();
