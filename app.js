/* ==========================================================================
   FILE 3 / 3: app.js
   Berisi: modal pembayaran, tampilan daftar folder & video, pemutar video
   fullscreen, breadcrumb, dan proses utama memuat folder (loadCurrentFolder)
   yang dijalankan begitu halaman dibuka.
   PENTING: file ini harus dimuat TERAKHIR, setelah core.js dan admin.js.
   ========================================================================== */

const paymentModal = document.getElementById('paymentModal');
const paymentFolderName = document.getElementById('paymentFolderName');
const paymentModalTitle = document.getElementById('paymentModalTitle');
const paymentPriceText = document.getElementById('paymentPriceText');
const paymentInfoBox = document.getElementById('paymentInfoBox');
const proofUploadLabel = document.getElementById('proofUploadLabel');
const proofUploadLabelText = document.getElementById('proofUploadLabelText');
const proofFileInput = document.getElementById('proofFileInput');
const proofFilename = document.getElementById('proofFilename');
const proofFilenameText = document.getElementById('proofFilenameText');
const paymentRequestBtn = document.getElementById('paymentRequestBtn');
const paymentStatusText = document.getElementById('paymentStatusText');
const paymentCloseBtn = document.getElementById('paymentCloseBtn');
let currentPaymentContext = null;
let paymentPollInterval = null;
let selectedProofFile = null;

const grid = document.getElementById('grid');
const folderPaymentNotice = document.getElementById('folderPaymentNotice');
const folderPaymentNoticeText = document.getElementById('folderPaymentNoticeText');
const foldersEl = document.getElementById('folders');
const foldersSection = document.getElementById('foldersSection');
const allAccessNotice = document.getElementById('allAccessNotice');
const allAccessNoticeText = document.getElementById('allAccessNoticeText');
const videosSection = document.getElementById('videosSection');
const statusText = document.getElementById('statusText');
const breadcrumbEl = document.getElementById('breadcrumb');
const pageTitle = document.getElementById('pageTitle');
const brandHomeBtn = document.getElementById('brandHomeBtn');
const backToFoldersBtn = document.getElementById('backToFoldersBtn');

function goToFolderHome(){
  path = [{ id: ROOT_FOLDER_ID, name: ROOT_FOLDER_LABEL }];
  loadCurrentFolder();
}
brandHomeBtn.addEventListener('click', goToFolderHome);
backToFoldersBtn.addEventListener('click', goToFolderHome);

const fullscreenModal = document.getElementById('fullscreenModal');
const modalIframe = document.getElementById('modalIframe');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalTitle = document.getElementById('modalTitle');
const modalContent = document.getElementById('modalContent');

let path = [{ id: ROOT_FOLDER_ID, name: ROOT_FOLDER_LABEL }];

function formatDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
}

function folderIcon(){
  return `VIP`;
}

function renderBreadcrumb(){
  breadcrumbEl.innerHTML = '';
  backToFoldersBtn.classList.toggle('visible', path.length > 1);
  if(path.length > 1){
    breadcrumbEl.classList.add('visible');
    path.slice(0, -1).forEach((p, i) => {
      if(i > 0){
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        breadcrumbEl.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.textContent = p.name;
      btn.onclick = () => {
        path = path.slice(0, i + 1);
        loadCurrentFolder();
      };
      breadcrumbEl.appendChild(btn);
    });
  } else {
    breadcrumbEl.classList.remove('visible');
  }
  pageTitle.textContent = path[path.length - 1].name;
}

// Cek tanggal upload terbaru DI DALAM tiap folder (bukan cuma tanggal
// folder-nya sendiri dibuat) — supaya folder lama yang baru ditambah
// video baru tetap kena tandai "Baru". Satu request gabungan untuk
// semua folder yang tampil, biar tidak boros API call.
async function fetchLatestChildTimes(folderIds){
  if(!folderIds.length) return {};
  const parentQuery = folderIds.map(id => `'${id}' in parents`).join(' or ');
  const query = encodeURIComponent(`(${parentQuery}) and trashed = false`);
  const fields = encodeURIComponent('files(id,parents,createdTime)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&pageSize=1000&key=${API_KEY}`;
  try{
    const res = await fetch(url);
    const data = await res.json();
    const map = {};
    (data.files || []).forEach(file => {
      const parent = file.parents && file.parents[0];
      if(!parent || !file.createdTime) return;
      const t = new Date(file.createdTime).getTime();
      if(!map[parent] || t > map[parent]) map[parent] = t;
    });
    return map;
  } catch(err){
    return {};
  }
}

async function renderFolders(folders){
  if(!folders.length){
    foldersSection.style.display = 'none';
    return;
  }
  foldersSection.style.display = 'block';
  foldersEl.innerHTML = '';

  // Ambil status pembayaran sekali saja untuk semua folder di halaman ini,
  // supaya tiap kartu bisa menampilkan "Sudah dibayar" / harga / gratis.
  const name = getCookie('visitorName') || '';
  const requests = await fetchPaymentRequests();
  const allAccessEntry = requests ? requests[requestKey(name, ALL_ACCESS_ID)] : null;
  const unlockedByAllAccess = ALL_ACCESS_ENABLED && !!(allAccessEntry && allAccessEntry.status === 'approved');
  const latestChildTimes = await fetchLatestChildTimes(folders.map(f => f.id));

  const paidFolderCount = folders.filter(f => !isFolderFree(f.id)).length;
  if(ALL_ACCESS_ENABLED && paidFolderCount > 0 && !unlockedByAllAccess){
    await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);
    const allAccessPrice = folderPrice(ALL_ACCESS_ID);
    const isPending = !!(allAccessEntry && allAccessEntry.status === 'pending');
    const btnLabel = isPending ? '⏳ Sedang di proses...' : 'Bayar Sekarang';
    const btnClass = isPending ? 'notice-pay-btn pending' : 'notice-pay-btn';
    allAccessNoticeText.innerHTML = `Bayar <strong>sekali</strong> seharga <strong>${priceHtml(ALL_ACCESS_ID)}</strong> untuk membuka <strong>semua ${paidFolderCount} folder</strong> berbayar di sini — bukan per folder.
      <button class="${btnClass}" id="allAccessPayBtn">${btnLabel}</button>`;
    allAccessNotice.style.display = 'flex';
    const allAccessPayBtn = document.getElementById('allAccessPayBtn');
    if(allAccessPayBtn){
      allAccessPayBtn.addEventListener('click', () => {
        openPaymentModal({ folderId: ALL_ACCESS_ID, folderName: ALL_ACCESS_NAME, price: allAccessPrice });
      });
    }
  } else {
    allAccessNotice.style.display = 'none';
  }

  // Hitung berapa kali tiap folder sudah "terjual" (permintaan berstatus
  // approved). Pembeli paket "Akses Semua Folder" dihitung sebagai pembeli
  // folder ini juga HANYA kalau folder ini sudah ada saat mereka membeli
  // (folder yang dibuat setelahnya tidak otomatis ikut, jadi tidak dihitung).
  const allApprovedList = requests ? Object.values(requests).filter(r => r.status === 'approved') : [];
  const allAccessApprovedEntries = allApprovedList.filter(r => r.folderId === ALL_ACCESS_ID);
  function soldCountFor(folder){
    const direct = allApprovedList.filter(r => r.folderId === folder.id).length;
    const coveredAllAccess = allAccessApprovedEntries.filter(e => isFolderCoveredByAllAccess(folder, e)).length;
    return direct + coveredAllAccess;
  }

  folders.forEach(f => {
    const card = document.createElement('button');
    card.className = 'folder-card';

    let tagHtml = 'Ketuk untuk buka';
    let tagClass = 'tag';
    let priceRowHtml = '';
    const free = isFolderFree(f.id);
    const coveredByAllAccess = isFolderCoveredByAllAccess(f, allAccessEntry);
    if(free){
      tagHtml = '🆓 Gratis';
      tagClass = 'tag free';
    } else if(coveredByAllAccess){
      tagHtml = '✅ Terbayar';
      tagClass = 'tag paid';
    } else {
      const key = requestKey(name, f.id);
      const entry = requests ? requests[key] : null;
      if(entry && entry.status === 'approved'){
        tagHtml = '✅ Sudah dibayar';
        tagClass = 'tag paid';
      } else if(entry && entry.status === 'pending'){
        tagHtml = '⏳ Menunggu konfirmasi';
        tagClass = 'tag pending';
        priceRowHtml = `<span class="price-row">${priceHtml(f.id)}</span>`;
      } else {
        tagHtml = '🔒 Berbayar';
        tagClass = 'tag locked';
        priceRowHtml = `<span class="price-row">${priceHtml(f.id)}</span>`;
      }
    }

    const soldHtml = !free
      ? `<span class="sold-badge">🛒 Terjual ${soldCountFor(f)}</span>`
      : '';

    // Tandai "Baru" kalau folder-nya sendiri dibuat dalam 2 hari terakhir,
    // ATAU ada video yang baru ditambahkan ke dalamnya dalam 2 hari terakhir.
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const ownCreated = f.createdTime ? new Date(f.createdTime).getTime() : 0;
    const childCreated = latestChildTimes[f.id] || 0;
    const latestActivity = Math.max(ownCreated, childCreated);
    const isNewFolder = latestActivity > 0 && (Date.now() - latestActivity) <= TWO_DAYS_MS;
    const newBadgeHtml = isNewFolder ? `<span class="new-badge">Baru</span>` : '';

    card.innerHTML = `
      ${newBadgeHtml}
      <span class="icon">${folderIcon()}</span>
      <span class="info">
        <span class="name">${f.name}</span>
        <span class="${tagClass}">${tagHtml}</span>
        ${priceRowHtml}
        ${soldHtml}
      </span>
    `;
    card.onclick = () => {
      requestFolderAccess(f);
    };
    foldersEl.appendChild(card);
  });
}

const modalVideo = document.getElementById('modalVideo');
let videoFallbackTimer = null;

// Coba tampilkan video pakai player HTML5 asli (kontrol kecil & rapi, bukan
// punya Google Drive). Kalau dalam beberapa detik videonya tidak kunjung
// siap, atau gagal dimuat (misal kena batas kuota Google Drive), otomatis
// jatuh kembali ke iframe preview Drive yang lama supaya video tetap bisa
// ditonton oleh pengunjung.
function openVideoFullscreen(fileId, fileName) {
  modalTitle.textContent = fileName;
  fullscreenModal.classList.add('active');
  document.body.style.overflow = 'hidden';
  tryCustomPlayer(fileId);
}

function tryCustomPlayer(fileId){
  clearTimeout(videoFallbackTimer);
  modalIframe.style.display = 'none';
  modalIframe.src = '';

  modalVideo.style.display = 'block';
  modalVideo.onerror = () => fallbackToDriveIframe(fileId);
  modalVideo.src = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${API_KEY}`;
  modalVideo.load();
  modalVideo.play().catch(() => { /* autoplay diblokir browser, pengunjung tinggal tekan play manual */ });

  videoFallbackTimer = setTimeout(() => {
    if(modalVideo.readyState === 0){
      fallbackToDriveIframe(fileId);
    }
  }, 6000);
}

function fallbackToDriveIframe(fileId){
  clearTimeout(videoFallbackTimer);
  modalVideo.onerror = null;
  modalVideo.pause();
  modalVideo.removeAttribute('src');
  modalVideo.load();
  modalVideo.style.display = 'none';

  modalIframe.style.display = 'block';
  modalIframe.src = `https://drive.google.com/file/d/${fileId}/preview`;
}

function closeFullscreenModal() {
  fullscreenModal.classList.remove('active');
  clearTimeout(videoFallbackTimer);

  modalIframe.src = '';
  modalIframe.style.display = 'block';

  modalVideo.onerror = null;
  modalVideo.pause();
  modalVideo.removeAttribute('src');
  modalVideo.load();
  modalVideo.style.display = 'none';

  document.body.style.overflow = '';
}

/* ====== MODAL PEMBAYARAN ====== */
function buildPaymentInfoHtml(lockInfo){
  const isAllAccess = lockInfo.folderId === ALL_ACCESS_ID;
  const badgeText = isAllAccess
    ? 'Bayar sekali, buka semua folder berbayar'
    : 'Bayar sekali, buka semua video di folder ini';
  const qrisUrl = isAllAccess
    ? (QRIS_ALL_ACCESS_IMAGE_URL || QRIS_IMAGE_URL)
    : QRIS_IMAGE_URL;
  let html = `<div class="one-time-badge"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>${badgeText}</div>`;
  if(qrisUrl){
    html += `<img src="${qrisUrl}" alt="QRIS">`;
  }
  if(BANK_TRANSFER_INFO){
    html += `<div><strong>Cara Bayar:</strong> ${BANK_TRANSFER_INFO}</div>`;
  }
  if(!qrisUrl && !BANK_TRANSFER_INFO){
    html += `<div>Hubungi admin via Messenger untuk info pembayaran.</div>`;
  }
  return html;
}

async function refreshPaymentModalStatus(){
  if(!currentPaymentContext) return;
  const name = getCookie('visitorName');
  if(!name) return;
  const data = await fetchPaymentRequests();
  if(data === null){
    paymentStatusText.className = 'payment-status';
    paymentStatusText.textContent = 'Konfigurasi penyimpanan belum diisi (SUPABASE_URL / SUPABASE_ANON_KEY).';
    return;
  }
  const key = requestKey(name, currentPaymentContext.folderId);
  const entry = data[key];
  if(!entry){
    paymentStatusText.className = 'payment-status';
    paymentStatusText.textContent = '';
    proofUploadLabel.style.display = 'flex';
    paymentRequestBtn.style.display = 'block';
    updateRequestBtnFromSelection();
    return;
  }
  if(entry.status === 'approved'){
    paymentStatusText.className = 'payment-status approved';
    paymentStatusText.textContent = 'Disetujui! Video sudah bisa diputar. Tutup jendela ini untuk mulai nonton.';
    proofUploadLabel.style.display = 'none';
    paymentRequestBtn.style.display = 'none';
    stopPaymentPolling();
    loadCurrentFolder();
  } else if(entry.status === 'rejected'){
    paymentStatusText.className = 'payment-status rejected';
    paymentStatusText.textContent = 'Permintaan ditolak admin. Silakan unggah ulang foto bukti transfer.';
    proofUploadLabel.style.display = 'flex';
    paymentRequestBtn.style.display = 'block';
    updateRequestBtnFromSelection();
  } else {
    paymentStatusText.className = 'payment-status pending';
    paymentStatusText.textContent = 'Menunggu konfirmasi admin...';
    proofUploadLabel.style.display = 'none';
    paymentRequestBtn.style.display = 'block';
    paymentRequestBtn.disabled = true;
    paymentRequestBtn.textContent = 'Sedang di proses...';
  }
}

function updateRequestBtnFromSelection(){
  if(selectedProofFile){
    paymentRequestBtn.disabled = false;
    paymentRequestBtn.textContent = 'Ajukan Akses';
  } else {
    paymentRequestBtn.disabled = true;
    paymentRequestBtn.textContent = 'Pilih foto dulu';
  }
}

function startPaymentPolling(){
  stopPaymentPolling();
  paymentPollInterval = setInterval(refreshPaymentModalStatus, 8000);
}
function stopPaymentPolling(){
  if(paymentPollInterval){ clearInterval(paymentPollInterval); paymentPollInterval = null; }
}

function openPaymentModal(lockInfo){
  currentPaymentContext = lockInfo;
  paymentModalTitle.textContent = lockInfo.folderId === ALL_ACCESS_ID ? 'Buka Semua Folder' : 'Folder Berbayar';
  paymentFolderName.textContent = lockInfo.folderName;
  paymentPriceText.innerHTML = priceHtml(lockInfo.folderId);
  paymentInfoBox.innerHTML = buildPaymentInfoHtml(lockInfo);
  selectedProofFile = null;
  proofFileInput.value = '';
  proofFilename.style.display = 'none';
  proofUploadLabelText.textContent = 'Pilih Foto Bukti Transfer';
  paymentModal.classList.add('active');
  refreshPaymentModalStatus();
  startPaymentPolling();
}

function closePaymentModal(){
  paymentModal.classList.remove('active');
  stopPaymentPolling();
}

paymentCloseBtn.addEventListener('click', closePaymentModal);
paymentModal.addEventListener('click', (e) => { if(e.target === paymentModal) closePaymentModal(); });

proofFileInput.addEventListener('change', () => {
  const file = proofFileInput.files && proofFileInput.files[0];
  if(!file) return;
  if(!file.type.startsWith('image/')){
    paymentStatusText.className = 'payment-status rejected';
    paymentStatusText.textContent = 'File harus berupa gambar (JPG/PNG).';
    return;
  }
  selectedProofFile = file;
  proofUploadLabelText.textContent = 'Ganti Foto';
  proofFilenameText.textContent = file.name;
  proofFilename.style.display = 'flex';
  updateRequestBtnFromSelection();
});

paymentRequestBtn.addEventListener('click', async () => {
  if(!currentPaymentContext || !selectedProofFile) return;
  const name = getCookie('visitorName');
  if(!name) return;
  const key = requestKey(name, currentPaymentContext.folderId);
  const existing = await fetchPaymentRequests();
  const entry = existing ? existing[key] : null;
  if(entry && entry.status === 'approved') return;
  // Jangan izinkan overwrite request yang masih pending —
  // pengunjung harus tunggu admin selesai review dulu.
  if(entry && entry.status === 'pending') return;

  paymentRequestBtn.disabled = true;
  paymentRequestBtn.textContent = 'Mengunggah foto...';
  const proofUrl = await uploadProofImage(selectedProofFile, key.replace(/[^a-z0-9]/gi, '_'));
  if(!proofUrl){
    paymentRequestBtn.disabled = false;
    paymentRequestBtn.textContent = 'Ajukan Akses';
    paymentStatusText.className = 'payment-status rejected';
    paymentStatusText.textContent = 'Gagal mengunggah foto. Coba lagi.';
    return;
  }
  paymentRequestBtn.textContent = 'Mengirim...';
  const newEntry = {
    name,
    folderId: currentPaymentContext.folderId,
    folderName: currentPaymentContext.folderName,
    price: currentPaymentContext.price,
    status: 'pending',
    proofUrl,
    requestedAt: Date.now(),
    updatedAt: Date.now()
  };
  await upsertPaymentRequest(key, newEntry);
  notifyTelegramNewPaymentRequest(newEntry); // tidak perlu ditunggu (await), tidak boleh menahan UI

  paymentStatusText.className = 'payment-status pending';
  paymentStatusText.textContent = 'Bukti transfer terkirim! Menunggu konfirmasi admin...';
  proofUploadLabel.style.display = 'none';
  paymentRequestBtn.style.display = 'none';
  setTimeout(() => {
    closePaymentModal();
  }, 1500);
});

function renderVideos(files, lockInfo){
  if(!files.length){
    videosSection.style.display = 'block';
    folderPaymentNotice.style.display = 'none';
    grid.innerHTML = `<div class="empty">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M21 8l-4 3 4 3z"/></svg>
      Belum ada video di folder ini.
    </div>`;
    return;
  }
  const locked = !!(lockInfo && lockInfo.locked);
  videosSection.style.display = 'block';
  if(locked){
    const isPending = !!(lockInfo && lockInfo.isPending);
    const btnLabel = isPending ? '⏳ Sedang di proses...' : 'Bayar Sekarang';
    const btnClass = isPending ? 'notice-pay-btn pending' : 'notice-pay-btn';
    folderPaymentNoticeText.innerHTML = `Bayar <strong>sekali</strong> seharga <strong>${priceHtml(lockInfo.folderId)}</strong> untuk membuka <strong>semua ${files.length} video</strong> di folder "${lockInfo.folderName}" ini — bukan per video.
      <button class="${btnClass}" id="noticePayBtn">${btnLabel}</button>`;
    folderPaymentNotice.style.display = 'flex';
    const noticePayBtn = document.getElementById('noticePayBtn');
    if(noticePayBtn){
      noticePayBtn.addEventListener('click', () => openPaymentModal(lockInfo));
    }
  } else {
    folderPaymentNotice.style.display = 'none';
  }
  grid.innerHTML = '';
  files.forEach(f => {
    const card = document.createElement('div');
    card.className = locked ? 'card locked' : 'card';
    const thumb = f.hasThumbnail && f.thumbnailLink
      ? f.thumbnailLink.replace(/=s\d+$/, '=s640')
      : '';
    card.innerHTML = `
      <div class="frame" data-file-id="${f.id}">
        ${thumb
          ? `<img src="${thumb}" alt="${f.name}" loading="lazy">`
          : `<div class="noThumb"></div>`}
        <button class="playBtn" aria-label="${locked ? 'Buka akses' : 'Putar video'}">
          ${locked
            ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`
            : `<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`}
        </button>
      </div>
    `;
    const playBtn = card.querySelector('.playBtn');

    const handleOpen = (e) => {
      if(e) e.stopPropagation();
      if(locked){
        openPaymentModal(lockInfo);
      } else {
        openVideoFullscreen(f.id, f.name);
      }
    };

    playBtn.addEventListener('click', handleOpen);
    card.addEventListener('click', handleOpen);

    grid.appendChild(card);
  });
}

function showSkeletons(){
  foldersSection.style.display = 'none';
  videosSection.style.display = 'block';
  folderPaymentNotice.style.display = 'none';
  grid.innerHTML = '';
  for(let i=0;i<6;i++){
    const s = document.createElement('div');
    s.className = 'skeleton';
    grid.appendChild(s);
  }
}

async function loadCurrentFolder(){
  const currentId = path[path.length - 1].id;
  renderBreadcrumb();

  if(API_KEY.startsWith('GANTI')){
    grid.innerHTML = `<div class="error">
      Konfigurasi belum diisi.
      <code>Buka file index.html, isi API_KEY di bagian atas &lt;script&gt;.</code>
    </div>`;
    statusText.textContent = 'Butuh konfigurasi';
    foldersSection.style.display = 'none';
    return;
  }

  showSkeletons();
  statusText.textContent = 'Memuat...';
  await Promise.all([ensureFolderPriceCache(), ensureDiscountCache()]);

  const query = encodeURIComponent(
    `'${currentId}' in parents and trashed = false and (mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`
  );
  const fields = encodeURIComponent('files(id,name,createdTime,mimeType,thumbnailLink,hasThumbnail)');
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=${fields}&orderBy=folder,createdTime desc&pageSize=200&key=${API_KEY}`;

  try{
    const res = await fetch(url);
    const data = await res.json();

    if(data.error){
      grid.innerHTML = `<div class="error">
        Gagal mengambil data dari Google Drive: ${data.error.message}
        <code>Cek lagi: API key aktif untuk Drive API, folder di-share publik ("Anyone with the link"), dan Folder ID benar.</code>
      </div>`;
      statusText.textContent = 'Gagal memuat';
      foldersSection.style.display = 'none';
      return;
    }

    const allFiles = data.files || [];
    const folders = allFiles.filter(f => f.mimeType === 'application/vnd.google-apps.folder');
    const videos = allFiles.filter(f => f.mimeType && f.mimeType.startsWith('video/'));

    await renderFolders(folders);
    if(folders.length > 0){
      videosSection.style.display = 'none';
    } else if(videos.length > 0 && !isFolderFree(currentId)){
      const visitorName = getCookie('visitorName');
      const price = folderPrice(currentId);
      const currentFolderInfo = path[path.length - 1];
      const folderName = currentFolderInfo.name;
      let unlocked = false;
      let isPending = false;
      if(visitorName){
        const requests = await fetchPaymentRequests();
        if(requests){
          const allAccessEntry = requests[requestKey(visitorName, ALL_ACCESS_ID)];
          const folderEntry = requests[requestKey(visitorName, currentId)];
          // Akses Semua Folder hanya berlaku untuk folder yang sudah ada
          // saat paket itu disetujui — folder baru tetap perlu dibayar sendiri.
          unlocked = ALL_ACCESS_ENABLED && isFolderCoveredByAllAccess(currentFolderInfo, allAccessEntry);
          if(!unlocked) unlocked = !!(folderEntry && folderEntry.status === 'approved');
          isPending = !unlocked && (
            !!(allAccessEntry && allAccessEntry.status === 'pending') ||
            !!(folderEntry && folderEntry.status === 'pending')
          );
        }
      }
      renderVideos(videos, { locked: !unlocked, folderId: currentId, folderName, price, isPending });
    } else {
      renderVideos(videos);
    }

    const now = new Date().toLocaleTimeString('id-ID');
    if(folders.length > 0){
      const visitorName = getCookie('visitorName');
      statusText.textContent = visitorName
        ? `Halo, ${visitorName} 👋 · ${folders.length} folder tersedia`
        : `${folders.length} folder tersedia`;
    } else {
      statusText.textContent = `${videos.length} video - terakhir dicek ${now}`;
    }
  }catch(err){
    grid.innerHTML = `<div class="error">Terjadi kesalahan jaringan. Coba refresh halaman.</div>`;
    statusText.textContent = 'Gagal memuat';
    foldersSection.style.display = 'none';
  }
}

modalCloseBtn.addEventListener('click', closeFullscreenModal);

fullscreenModal.addEventListener('click', (e) => {
  if (e.target === fullscreenModal) {
    closeFullscreenModal();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fullscreenModal.classList.contains('active')) {
    closeFullscreenModal();
  }
});

if(existingVisitorName){
  loadCurrentFolder();
  startHeartbeat(existingVisitorName);
}
let autoRefreshInterval = null;
if(AUTO_REFRESH_SECONDS > 0){
  autoRefreshInterval = setInterval(() => {
    if(getCookie('visitorName')){
      loadCurrentFolder();
    } else {
      // User sudah logout, hentikan auto-refresh
      clearInterval(autoRefreshInterval);
      autoRefreshInterval = null;
    }
  }, AUTO_REFRESH_SECONDS * 1000);
}
