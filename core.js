/* ==========================================================================
   FILE 1 / 3: core.js
   Berisi: konfigurasi (API key, Supabase, harga), fungsi bantu (cookie,
   format rupiah, cek folder gratis/berbayar, dll), sistem login pengunjung,
   dan modal profil.
   PENTING: file ini harus dimuat PERTAMA, sebelum admin.js dan app.js,
   karena keduanya memakai konstanta & fungsi yang didefinisikan di sini.
   ========================================================================== */

const API_KEY = "AIzaSyB8MY-5lLPOirCFvXO8qEwHgY5zntv0m4c";
const ROOT_FOLDER_ID = "1VizdRT_3gIRqGtyn8PAGfm6kH7ZPLK9E";
// Label ini muncul sebagai judul halaman utama & label "pulang" di breadcrumb.
// Ganti teksnya di sini kapan saja tanpa perlu cari-cari di tempat lain.
const ROOT_FOLDER_LABEL = "Koleksi VIP";
const AUTO_REFRESH_SECONDS = 0;

const SUPABASE_URL = "https://dwahqcqbytpczvgbzunm.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jQ7V9lI2DcT3oSrpj0XpGw_6r7YwPHF";
const PROOF_BUCKET = 'payment-proofs';
const HEARTBEAT_SECONDS = 15;
const ONLINE_TIMEOUT_SECONDS = 60;
// PENTING: hash password admin TIDAK lagi disimpan di sini.
// Verifikasi password sekarang dilakukan di server (Supabase RPC),
// supaya orang yang buka "View Source" tidak bisa lihat/pakai hash-nya
// untuk memalsukan sesi admin. Lihat file admin-security-fix.sql.
const ADMIN_SESSION_HOURS = 2;

let sb = null;
if(!SUPABASE_URL.startsWith('GANTI') && !SUPABASE_ANON_KEY.startsWith('GANTI') && window.supabase){
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
function dbReady(){ return sb !== null; }

const PAYMENT_ENABLED = true;
const DEFAULT_PRICE = 50000;
const ALL_ACCESS_ENABLED = true;
const ALL_ACCESS_DEFAULT_PRICE = 100000; // fallback jika admin belum pernah mengubah harga ini
const ALL_ACCESS_ID = '__ALL_ACCESS__';
const ALL_ACCESS_NAME = 'Akses Semua Folder';
const FOLDER_PRICES = {

};
const FREE_FOLDER_IDS = [

];
const FACEBOOK_USERNAME = 'firaafriliaaaa';
const QRIS_IMAGE_URL = 'https://layarbiru.xyz/qris.jpg';
const QRIS_ALL_ACCESS_IMAGE_URL = 'https://layarbiru.xyz/qris-all.png';
const BANK_TRANSFER_INFO = 'Scan QR di atas menggunakan aplikasi m-banking atau e-wallet kamu untuk membayar.';

// Isi dengan token bot & chat ID kamu dari @BotFather / getUpdates.
// Kalau salah satunya masih 'GANTI...', notifikasi Telegram otomatis dimatikan.
const TELEGRAM_BOT_TOKEN = '8888905749:AAF26albgKi3nCOEZL4SJnSuLI6WE8k2hMw';
const TELEGRAM_CHAT_ID = '7039626075';
function telegramReady(){
  return !TELEGRAM_BOT_TOKEN.startsWith('GANTI') && !TELEGRAM_CHAT_ID.startsWith('GANTI');
}

// Kirim notifikasi ke Telegram setiap ada bukti transfer baru masuk,
// lengkap dengan foto buktinya, supaya admin bisa langsung cek & approve
// dari HP tanpa harus buka dashboard terus-menerus.
async function notifyTelegramNewPaymentRequest(entry){
  if(!telegramReady()) return;
  const isAllAccess = entry.folderId === ALL_ACCESS_ID;
  const caption = `🔔 *Bukti transfer baru!*\n\n`
    + `👤 Nama: ${entry.name}\n`
    + `📁 ${isAllAccess ? 'Paket' : 'Folder'}: ${entry.folderName}\n`
    + `💰 Harga: ${formatRupiah(entry.price)}\n\n`
    + `Buka dashboard admin di situs untuk menyetujui/menolak permintaan ini.`;
  try{
    if(entry.proofUrl){
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          photo: entry.proofUrl,
          caption,
          parse_mode: 'Markdown'
        })
      });
    } else {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: caption,
          parse_mode: 'Markdown'
        })
      });
    }
  }catch(e){
    // Gagal kirim notifikasi Telegram tidak boleh mengganggu alur pembayaran utama.
  }
}

function setCookie(name, value, hours){
  const d = new Date();
  d.setTime(d.getTime() + hours * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}
function getCookie(name){
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

function getSessionId(){
  // Pakai localStorage (bukan sessionStorage) supaya session_id tetap sama
  // walau tab di-reload atau dibuka ulang di HP yang sama. Ini mencegah
  // satu pengunjung yang sama terhitung sebagai 2 "player online" berbeda
  // di dashboard admin saat browser mem-reset sessionStorage.
  let sid = localStorage.getItem('sessionId');
  if(!sid){
    sid = 'p_' + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem('sessionId', sid);
  }
  return sid;
}

async function sendHeartbeat(name){
  if(!dbReady()) return;
  try{
    const { error } = await sb.from('active_players').upsert({
      session_id: getSessionId(),
      name,
      last_seen: new Date().toISOString()
    }, { onConflict: 'session_id' });
    if(error){
      console.warn('[sendHeartbeat] Supabase error:', error.message,
        '— Cek RLS policy INSERT/UPDATE untuk tabel active_players.');
    }
  }catch(e){
    console.warn('[sendHeartbeat] Exception:', e);
  }
}

async function fetchActivePlayers(){
  if(!dbReady()) return null;
  try{
    // Filter langsung di server: hanya ambil row yang last_seen-nya masih dalam
    // batas ONLINE_TIMEOUT_SECONDS, bukan filter manual di sisi client.
    // Ini mencegah bug di mana query berhasil tapi semua row sudah expired
    // sehingga hasilnya selalu kosong.
    const cutoff = new Date(Date.now() - ONLINE_TIMEOUT_SECONDS * 1000).toISOString();
    const { data, error } = await sb
      .from('active_players')
      .select('*')
      .gte('last_seen', cutoff);
    if(error){
      console.warn('[fetchActivePlayers] Supabase error:', error.message,
        '— Kemungkinan RLS belum diset. Jalankan SQL policy di Supabase.');
      return {};
    }
    const obj = {};
    (data || []).forEach(row => {
      obj[row.session_id] = { name: row.name, lastSeen: new Date(row.last_seen).getTime() };
    });
    return obj;
  }catch(e){
    console.warn('[fetchActivePlayers] Exception:', e);
    return {};
  }
}

let heartbeatInterval = null;
let heartbeatName = null;
function startHeartbeat(name){
  heartbeatName = name;
  sendHeartbeat(name);
  if(heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => sendHeartbeat(name), HEARTBEAT_SECONDS * 1000);
}

// Kalau tab disembunyikan (ganti aplikasi, kunci layar, minimize), hentikan
// heartbeat supaya status "online" berhenti diperbarui dan otomatis dianggap
// offline setelah ONLINE_TIMEOUT_SECONDS — bukannya nyangkut online terus
// padahal orangnya sudah tidak sedang melihat halaman ini.
document.addEventListener('visibilitychange', () => {
  if(!heartbeatName) return;
  if(document.visibilityState === 'hidden'){
    if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
  } else if(document.visibilityState === 'visible'){
    sendHeartbeat(heartbeatName);
    if(heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => sendHeartbeat(heartbeatName), HEARTBEAT_SECONDS * 1000);
  }
});

// Kalau tab benar-benar ditutup / dinavigasi keluar, langsung hapus baris
// presence-nya dari database (bukan cuma menunggu timeout 45 detik), supaya
// status di dashboard admin lebih instan & akurat. Pakai fetch REST manual
// dengan keepalive supaya requestnya tidak dibatalkan browser saat halaman
// sedang ditutup (client supabase-js biasa tidak menjamin ini selesai terkirim).
function removeActivePlayerBeacon(){
  if(!dbReady()) return;
  try{
    const url = `${SUPABASE_URL}/rest/v1/active_players?session_id=eq.${encodeURIComponent(getSessionId())}`;
    fetch(url, {
      method: 'DELETE',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      },
      keepalive: true
    });
  }catch(e){}
}
window.addEventListener('pagehide', removeActivePlayerBeacon);

async function fetchPaymentRequests(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('payment_requests').select('*');
    if(error) return {};
    const obj = {};
    (data || []).forEach(row => {
      obj[row.key] = {
        name: row.name,
        folderId: row.folder_id,
        folderName: row.folder_name,
        price: row.price,
        status: row.status,
        proofUrl: row.proof_url || null,
        requestedAt: new Date(row.requested_at).getTime(),
        updatedAt: new Date(row.updated_at).getTime()
      };
    });
    return obj;
  }catch(e){ return {}; }
}

async function upsertPaymentRequest(key, entry){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('payment_requests').upsert({
      key,
      name: entry.name,
      folder_id: entry.folderId,
      folder_name: entry.folderName,
      price: entry.price,
      status: entry.status,
      proof_url: entry.proofUrl || null,
      requested_at: new Date(entry.requestedAt).toISOString(),
      updated_at: new Date(entry.updatedAt).toISOString()
    });
    return !error;
  }catch(e){ return false; }
}

async function setPaymentRequestStatus(key, status){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('payment_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('key', key);
    return !error;
  }catch(e){ return false; }
}

async function deletePaymentRequest(key){
  if(!dbReady()) return false;
  try{

    const { data, error } = await sb.from('payment_requests')
      .delete()
      .eq('key', key)
      .select();
    if(error) return false;
    return !!(data && data.length > 0);
  }catch(e){ return false; }
}

async function deleteAllPaymentRequests(){
  if(!dbReady()) return false;
  try{
    const { data, error } = await sb.from('payment_requests')
      .delete()
      .not('key', 'is', null)
      .select();
    if(error) return false;
    return data ? data.length : 0;
  }catch(e){ return false; }
}

async function uploadProofImage(file, requestKeySlug){
  if(!dbReady() || !file) return null;
  try{
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${requestKeySlug}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(PROOF_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false
    });
    if(error) return null;
    const { data } = sb.storage.from(PROOF_BUCKET).getPublicUrl(path);
    return data ? data.publicUrl : null;
  }catch(e){ return null; }
}

let discountPercentCache = null;

async function fetchDiscountPercent(){
  if(!dbReady()) return 0;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'discount_percent').maybeSingle();
    if(error || !data) return 0;
    const n = parseFloat(data.value);
    return isNaN(n) ? 0 : n;
  }catch(e){ return 0; }
}

async function ensureDiscountCache(){
  if(discountPercentCache === null){
    discountPercentCache = await fetchDiscountPercent();
  }
  return discountPercentCache;
}

async function saveDiscountPercent(percent){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('app_settings').upsert({
      key: 'discount_percent',
      value: String(percent),
      updated_at: new Date().toISOString()
    });
    if(!error) discountPercentCache = percent;
    return !error;
  }catch(e){ return false; }
}

// Diskon dianggap aktif kalau persennya > 0. Berlaku terus sampai admin
// mengubahnya lagi (tidak ada batas waktu / countdown).
function isDiscountActive(){
  const pct = discountPercentCache || 0;
  return pct > 0;
}

function applyDiscount(price){
  if(!isDiscountActive()) return price;
  const pct = discountPercentCache || 0;
  const discounted = Math.round(price * (1 - pct / 100));
  return discounted < 0 ? 0 : discounted;
}

// ====== "Perbarui Cache CSS/JS": bump versi aset supaya index.html (lewat
// bootstrap script di <head>) otomatis mengambil style.css/core.js/admin.js/
// app.js versi terbaru di kunjungan berikutnya, tanpa perlu admin mengubah
// "?v=..." manual di file HTML. Disimpan di app_settings key 'asset_version'.
async function fetchAssetVersion(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'asset_version').maybeSingle();
    if(error || !data) return null;
    return data.value;
  }catch(e){ return null; }
}

async function saveAssetVersion(v){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('app_settings').upsert({
      key: 'asset_version',
      value: String(v),
      updated_at: new Date().toISOString()
    });
    return !error;
  }catch(e){ return false; }
}

// ====== "Hapus Cache" admin: paksa semua pengunjung logout & login ulang ======
// Disimpan sebagai timestamp (ms) di tabel app_settings (key 'force_logout_after').
// Setiap pengunjung menyimpan kapan dia login terakhir kali (cookie 'visitorLoginAt').
// Kalau force_logout_after lebih baru daripada visitorLoginAt milik pengunjung,
// berarti admin menekan "Hapus Cache" SETELAH pengunjung itu login -> paksa logout.
let forceLogoutAfterCache = null;

async function fetchForceLogoutAfter(){
  if(!dbReady()) return 0;
  try{
    const { data, error } = await sb.from('app_settings').select('value').eq('key', 'force_logout_after').maybeSingle();
    if(error || !data) return 0;
    const n = parseInt(data.value, 10);
    return isNaN(n) ? 0 : n;
  }catch(e){ return 0; }
}

async function saveForceLogoutAfter(ts){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('app_settings').upsert({
      key: 'force_logout_after',
      value: String(ts),
      updated_at: new Date().toISOString()
    });
    if(!error) forceLogoutAfterCache = ts;
    return !error;
  }catch(e){ return false; }
}

// Dipanggil saat halaman dibuka & secara berkala selama pengunjung online,
// supaya kalau admin menekan "Hapus Cache" ketika pengunjung sedang aktif,
// dia langsung ter-logout tanpa perlu reload manual.
async function checkForceLogoutAndApply(){
  const currentName = getCookie('visitorName');
  if(!currentName || !dbReady()) return false;
  const forceAfter = await fetchForceLogoutAfter();
  if(!forceAfter) return false;
  // Kalau tidak ada catatan waktu login (cookie lama dari sebelum fitur ini ada),
  // anggap login-nya "sangat lama" supaya tetap ikut ter-reset juga.
  const loginAt = parseInt(getCookie('visitorLoginAt') || '0', 10);
  if(loginAt < forceAfter){
    await logoutVisitor();
    return true;
  }
  return false;
}

let forceLogoutWatchInterval = null;
function startForceLogoutWatch(){
  if(forceLogoutWatchInterval) clearInterval(forceLogoutWatchInterval);
  checkForceLogoutAndApply();
  forceLogoutWatchInterval = setInterval(checkForceLogoutAndApply, HEARTBEAT_SECONDS * 1000);
}

let folderPriceCache = null;

async function fetchFolderPrices(){
  if(!dbReady()) return {};
  try{
    const { data, error } = await sb.from('folder_prices').select('*');
    if(error) return {};
    const obj = {};
    (data || []).forEach(row => { obj[row.folder_id] = row.price; });
    return obj;
  }catch(e){ return {}; }
}

async function ensureFolderPriceCache(){
  if(folderPriceCache === null){
    folderPriceCache = await fetchFolderPrices();
  }
  return folderPriceCache;
}

async function saveFolderPrice(folderId, folderName, price){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('folder_prices').upsert({
      folder_id: folderId,
      folder_name: folderName,
      price: price,
      updated_at: new Date().toISOString()
    });
    if(!error && folderPriceCache) folderPriceCache[folderId] = price;
    return !error;
  }catch(e){ return false; }
}

function requestKey(name, folderId){
  return `${name.trim().toLowerCase()}__${folderId}`;
}

// ===== Sistem Pemberitahuan (dikirim admin, muncul di lonceng semua pengguna) =====

async function fetchNotifications(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}

async function sendNotificationDb(title, message){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('notifications').insert({ title, message });
    return !error;
  }catch(e){ return false; }
}

async function deleteNotificationDb(id){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('notifications').delete().eq('id', id);
    return !error;
  }catch(e){ return false; }
}

// ===== Sistem Testimoni (diisi langsung oleh pengunjung, tampil ke semua orang) =====

async function fetchTestimonials(){
  if(!dbReady()) return null;
  try{
    const { data, error } = await sb.from('testimonials')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100);
    if(error) return null;
    return data || [];
  }catch(e){ return null; }
}

async function sendTestimonialDb(name, message){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('testimonials').insert({ name, message });
    return !error;
  }catch(e){ return false; }
}

async function deleteTestimonialDb(id){
  if(!dbReady()) return false;
  try{
    const { error } = await sb.from('testimonials').delete().eq('id', id);
    return !error;
  }catch(e){ return false; }
}

// ID pemberitahuan terakhir yang sudah dilihat pengguna ini, disimpan per browser
// supaya badge "belum dibaca" tetap akurat walau halaman di-refresh.
function getLastSeenNotifId(){
  return parseInt(localStorage.getItem('notifLastSeenId') || '0', 10);
}
function setLastSeenNotifId(id){
  localStorage.setItem('notifLastSeenId', String(id));
}

async function sha256Hex(text){
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function basePrice(folderId){
  // Kalau admin sudah pernah mengubah harga folder ini lewat dashboard,
  // dan cache-nya sudah termuat, pakai harga itu. Kalau belum termuat,
  // pakai fallback (FOLDER_PRICES / DEFAULT_PRICE) sambil cache dimuat
  // di latar belakang oleh ensureFolderPriceCache().
  if(folderPriceCache && folderPriceCache.hasOwnProperty(folderId)){
    return folderPriceCache[folderId];
  }
  if(folderId === ALL_ACCESS_ID) return ALL_ACCESS_DEFAULT_PRICE;
  return FOLDER_PRICES.hasOwnProperty(folderId) ? FOLDER_PRICES[folderId] : DEFAULT_PRICE;
}

function folderPrice(folderId){
  // Harga dasar (dari admin / fallback), lalu dipotong otomatis oleh
  // diskon global kalau admin sudah mengatur diskon di dashboard.
  // Pengecualian: paket "Akses Semua Folder" tidak pernah kena diskon.
  const price = basePrice(folderId);
  if(price === 0) return 0; // folder gratis tetap gratis, tidak perlu "didiskon"
  if(folderId === ALL_ACCESS_ID) return price;
  return applyDiscount(price);
}

function isFolderFree(folderId){
  return !PAYMENT_ENABLED || !dbReady() || FREE_FOLDER_IDS.includes(folderId) || folderPrice(folderId) === 0;
}

// Paket "Akses Semua Folder" cuma membuka folder yang SUDAH ADA pada saat
// pembelian disetujui. Folder yang dibuat SETELAH itu (folder baru) tidak
// otomatis ikut terbuka — tetap perlu dibayar terpisah per folder.
function isFolderCoveredByAllAccess(folder, allAccessEntry){
  if(!allAccessEntry || allAccessEntry.status !== 'approved') return false;
  if(!folder || !folder.createdTime) return true; // aman: kalau tanggalnya tidak diketahui, jangan restriktif
  const approvedAt = allAccessEntry.updatedAt || allAccessEntry.requestedAt;
  return new Date(folder.createdTime).getTime() <= approvedAt;
}

// Cek apakah pengunjung (berdasarkan nama di cookie) sudah punya paket
// "bayar sekali buka semua folder" yang sudah disetujui admin.
async function hasAllAccess(){
  if(!ALL_ACCESS_ENABLED || !dbReady()) return false;
  const name = getCookie('visitorName');
  if(!name) return false;
  const requests = await fetchPaymentRequests();
  if(!requests) return false;
  const key = requestKey(name, ALL_ACCESS_ID);
  const entry = requests[key];
  return !!(entry && entry.status === 'approved');
}

function formatRupiah(n){
  return 'Rp' + Number(n).toLocaleString('id-ID');
}

// Sanitasi string sebelum dimasukkan ke innerHTML, mencegah XSS.
// Wajib dipakai untuk SEMUA data yang berasal dari DB / input pengguna.
function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Menghasilkan potongan HTML harga yang otomatis menampilkan harga normal
// dicoret + harga setelah diskon + badge persen, kalau admin sedang
// mengaktifkan diskon global. Paket "Akses Semua Folder" tidak pernah
// didiskon, jadi selalu tampil harga normal saja.
function priceHtml(folderId){
  const base = basePrice(folderId);
  if(base === 0) return 'Gratis';
  const isAllAccess = folderId === ALL_ACCESS_ID;
  if(!isAllAccess && isDiscountActive()){
    const discounted = applyDiscount(base);
    const pct = discountPercentCache || 0;
    return `<span class="price-wrap"><span class="price-original">${formatRupiah(base)}</span><span class="price-discounted">${formatRupiah(discounted)}</span><span class="discount-badge">-${pct}%</span></span>`;
  }
  return `<span class="price-plain">${formatRupiah(base)}</span>`;
}

const gateOverlay = document.getElementById('gateOverlay');
const gateNameInput = document.getElementById('gateNameInput');
const gatePasswordInput = document.getElementById('gatePasswordInput');
const gateError = document.getElementById('gateError');
const gateSubmitBtn = document.getElementById('gateSubmitBtn');

const notifBellBtn = document.getElementById('notifBellBtn');
const notifBadge = document.getElementById('notifBadge');
const notifModal = document.getElementById('notifModal');
const notifCloseBtn = document.getElementById('notifCloseBtn');
const notifList = document.getElementById('notifList');
let notifPollInterval = null;

const testiBtn = document.getElementById('testiBtn');
const testiModal = document.getElementById('testiModal');
const testiCloseBtn = document.getElementById('testiCloseBtn');
const testiList = document.getElementById('testiList');
const testiMessageInput = document.getElementById('testiMessageInput');
const testiError = document.getElementById('testiError');
const testiSubmitBtn = document.getElementById('testiSubmitBtn');

const profileCornerBtn = document.getElementById('profileCornerBtn');
const profileModal = document.getElementById('profileModal');
const profileNameText = document.getElementById('profileNameText');
const profileAvatar = document.getElementById('profileAvatar');
const cornerAvatarText = document.getElementById('cornerAvatarText');
const profileLogoutBtn = document.getElementById('profileLogoutBtn');
const profileCloseBtn = document.getElementById('profileCloseBtn');
const profilePaymentsList = document.getElementById('profilePaymentsList');
let profilePaymentsPollInterval = null;

const profileSecurityInfo = document.getElementById('profileSecurityInfo');
const profileSecurityForm = document.getElementById('profileSecurityForm');
const profileOldPasswordInput = document.getElementById('profileOldPasswordInput');
const profileNewPasswordInput = document.getElementById('profileNewPasswordInput');
const profileNewPasswordConfirm = document.getElementById('profileNewPasswordConfirm');
const profileSecurityError = document.getElementById('profileSecurityError');
const profileSecuritySubmitBtn = document.getElementById('profileSecuritySubmitBtn');
let profileHasPasswordCache = false;

// Warna avatar konsisten per nama, jadi tiap pengunjung punya "warna" sendiri
// yang tidak berubah-ubah tiap kali dia login lagi.
const AVATAR_COLORS = ['#e8a33d', '#5fbf8e', '#6ea8e8', '#e07bb0', '#c98620', '#7ad1c9', '#e08a5f', '#a08de8'];
function avatarColorFor(name){
  let hash = 0;
  for(let i = 0; i < name.length; i++){ hash = (hash * 31 + name.charCodeAt(i)) >>> 0; }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}
function avatarInitial(name){
  const trimmed = (name || '').trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : '?';
}

function showUserBadge(name){
  profileNameText.textContent = name;
  profileCornerBtn.style.display = 'flex';
  if(notifBellBtn) notifBellBtn.style.display = 'flex';
  if(testiBtn) testiBtn.style.display = 'flex';

  const initial = avatarInitial(name);
  const color = avatarColorFor(name.trim().toLowerCase());
  cornerAvatarText.textContent = initial;
  cornerAvatarText.style.background = color;
  profileAvatar.textContent = initial;
  profileAvatar.style.background = color;

  refreshNotifBadge();
  if(notifPollInterval) clearInterval(notifPollInterval);
  notifPollInterval = setInterval(refreshNotifBadge, 20000);
}

function hideUserBadge(){
  profileCornerBtn.style.display = 'none';
  profileModal.classList.remove('active');
  if(notifBellBtn) notifBellBtn.style.display = 'none';
  if(notifModal) notifModal.classList.remove('active');
  if(testiBtn) testiBtn.style.display = 'none';
  if(testiModal) testiModal.classList.remove('active');
  if(notifPollInterval){ clearInterval(notifPollInterval); notifPollInterval = null; }
}

// Cek pemberitahuan baru & perbarui titik merah di ikon lonceng.
async function refreshNotifBadge(){
  if(!notifBadge) return;
  const list = await fetchNotifications();
  if(!list || !list.length){
    notifBadge.style.display = 'none';
    return;
  }
  const lastSeen = getLastSeenNotifId();
  const unreadCount = list.filter(n => n.id > lastSeen).length;
  if(unreadCount > 0){
    notifBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    notifBadge.style.display = 'flex';
  } else {
    notifBadge.style.display = 'none';
  }
}

// Format waktu singkat untuk pemberitahuan (mis. "5 menit lalu", "2 jam lalu").
function notifTimeAgo(isoString){
  const ts = new Date(isoString).getTime();
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

async function renderNotifList(){
  if(!notifList) return;
  notifList.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const list = await fetchNotifications();
  if(!list){
    notifList.innerHTML = `<div class="profile-payments-empty">Gagal memuat pemberitahuan.</div>`;
    return;
  }
  if(!list.length){
    notifList.innerHTML = `<div class="profile-payments-empty">Belum ada pemberitahuan.</div>`;
    return;
  }
  notifList.innerHTML = list.map(n => `
    <div class="profile-payment-item">
      <div class="profile-payment-item-top">
        <span class="ppn-name">${escapeHtml(n.title)}</span>
      </div>
      <div class="notif-message">${escapeHtml(n.message)}</div>
      <span class="ppn-price">${notifTimeAgo(n.created_at)}</span>
    </div>
  `).join('');
  // Tandai semua sudah dibaca (id terbesar) begitu daftar dibuka.
  const maxId = Math.max(...list.map(n => n.id));
  setLastSeenNotifId(maxId);
  if(notifBadge) notifBadge.style.display = 'none';
}

if(notifBellBtn){
  notifBellBtn.addEventListener('click', () => {
    notifModal.classList.add('active');
    renderNotifList();
  });
}
if(notifCloseBtn){
  notifCloseBtn.addEventListener('click', () => notifModal.classList.remove('active'));
}
if(notifModal){
  notifModal.addEventListener('click', (e) => {
    if(e.target === notifModal) notifModal.classList.remove('active');
  });
}

// Sensor nama pengguna sebelum ditampilkan di daftar testimoni publik
// (menyisakan 2 huruf pertama tiap kata, sisanya jadi bintang), karena
// tidak semua pengguna memakai password untuk melindungi identitasnya.
function maskName(name){
  const trimmed = (name || '').trim();
  if(!trimmed) return 'Pengguna';
  return trimmed.split(/\s+/).map(word => {
    if(word.length <= 2) return word.charAt(0) + '*'.repeat(Math.max(word.length - 1, 1));
    return word.slice(0, 2) + '*'.repeat(word.length - 2);
  }).join(' ');
}

async function renderTestiList(){
  if(!testiList) return;
  testiList.innerHTML = `<div class="profile-payments-empty">Memuat...</div>`;
  const list = await fetchTestimonials();
  if(!list){
    testiList.innerHTML = `<div class="profile-payments-empty">Gagal memuat testimoni.</div>`;
    return;
  }
  if(!list.length){
    testiList.innerHTML = `<div class="profile-payments-empty">Belum ada testimoni. Jadilah yang pertama!</div>`;
    return;
  }
  testiList.innerHTML = list.map(t => `
    <div class="profile-payment-item">
      <div class="profile-payment-item-top">
        <span class="ppn-name">${escapeHtml(maskName(t.name))}</span>
      </div>
      <div class="notif-message">${escapeHtml(t.message)}</div>
      <span class="ppn-price">${notifTimeAgo(t.created_at)}</span>
    </div>
  `).join('');
}

if(testiBtn){
  testiBtn.addEventListener('click', () => {
    testiModal.classList.add('active');
    if(testiError) testiError.textContent = '';
    renderTestiList();
  });
}
if(testiCloseBtn){
  testiCloseBtn.addEventListener('click', () => testiModal.classList.remove('active'));
}
if(testiModal){
  testiModal.addEventListener('click', (e) => {
    if(e.target === testiModal) testiModal.classList.remove('active');
  });
}
if(testiSubmitBtn){
  testiSubmitBtn.addEventListener('click', async () => {
    const message = testiMessageInput.value.trim();
    testiError.textContent = '';
    if(!message){
      testiError.textContent = 'Tulis dulu testimoni kamu.';
      return;
    }
    const name = getCookie('visitorName');
    if(!name){
      testiError.textContent = 'Kamu harus masuk dulu untuk mengirim testimoni.';
      return;
    }
    testiSubmitBtn.disabled = true;
    testiSubmitBtn.textContent = 'Mengirim...';
    const ok = await sendTestimonialDb(name.trim(), message);
    testiSubmitBtn.disabled = false;
    testiSubmitBtn.textContent = 'Kirim Testimoni';
    if(ok){
      testiMessageInput.value = '';
      renderTestiList();
    } else {
      testiError.textContent = 'Gagal mengirim testimoni. Coba lagi.';
    }
  });
}

// Label & kelas badge status untuk ditampilkan ke pengunjung sendiri
// (bahasa lebih ramah dibanding status mentah 'pending'/'approved'/'rejected').
function paymentStatusBadge(status){
  if(status === 'approved') return { text: 'Disetujui ✓', cls: 'approved' };
  if(status === 'rejected') return { text: 'Ditolak', cls: 'rejected' };
  return { text: 'Sedang di proses...', cls: 'pending' };
}

// Tampilkan daftar pembayaran milik pengunjung yang sedang login, supaya dia
// bisa cek sendiri statusnya tanpa harus tanya admin lewat Messenger dulu.
async function renderProfilePayments(){
  const name = getCookie('visitorName');
  if(!profilePaymentsList) return;
  if(!name || !dbReady()){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Belum ada data pembayaran.</div>`;
    return;
  }
  const requests = await fetchPaymentRequests();
  if(!requests){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Gagal memuat status pembayaran.</div>`;
    return;
  }
  const mine = Object.values(requests)
    .filter(r => r && r.name === name)
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));

  if(!mine.length){
    profilePaymentsList.innerHTML = `<div class="profile-payments-empty">Belum ada pembayaran yang diajukan.</div>`;
    return;
  }

  profilePaymentsList.innerHTML = mine.map(r => {
    const badge = paymentStatusBadge(r.status);
    return `
      <div class="profile-payment-item">
        <div class="profile-payment-item-top">
          <span class="ppn-name">${escapeHtml(r.folderName)}</span>
          <span class="profile-payment-badge ${badge.cls}">${badge.text}</span>
        </div>
        <span class="ppn-price">${formatRupiah(r.price)} · ${timeAgo(r.requestedAt)}</span>
      </div>
    `;
  }).join('');
}

// Cek & tampilkan status password akun pengunjung ini di tab Profil,
// supaya dia bisa BUAT password (kalau belum punya) atau UBAH password
// (kalau sudah pernah dibuat) tanpa perlu diminta password di gerbang login
// sebelum dia benar-benar mengaktifkannya sendiri.
async function renderProfileSecurity(){
  const name = getCookie('visitorName');
  if(!profileSecurityInfo) return;
  profileSecurityError.textContent = '';
  if(!name || !dbReady()){
    profileSecurityInfo.textContent = 'Supabase belum dikonfigurasi.';
    profileSecurityForm.style.display = 'none';
    return;
  }
  let hasPassword = false;
  try{
    const { data, error } = await sb.rpc('visitor_check_password', { input_username: name });
    if(!error) hasPassword = !!data;
  }catch(e){ hasPassword = false; }

  profileHasPasswordCache = hasPassword;
  profileOldPasswordInput.value = '';
  profileNewPasswordInput.value = '';
  profileNewPasswordConfirm.value = '';

  if(hasPassword){
    profileSecurityInfo.textContent = 'Password sudah diatur untuk akun ini. Kamu bisa menggantinya di bawah.';
    profileOldPasswordInput.style.display = 'block';
    profileSecuritySubmitBtn.textContent = 'Ubah Password';
  } else {
    profileSecurityInfo.textContent = 'Kamu belum membuat password. Buat sekarang supaya username ini tidak bisa dipakai orang lain.';
    profileOldPasswordInput.style.display = 'none';
    profileSecuritySubmitBtn.textContent = 'Buat Password';
  }
  profileSecurityForm.style.display = 'flex';
}

profileSecuritySubmitBtn.addEventListener('click', async () => {
  const name = getCookie('visitorName');
  if(!name || !dbReady()) return;

  const oldPassword = profileOldPasswordInput.value;
  const newPassword = profileNewPasswordInput.value;
  const confirmPassword = profileNewPasswordConfirm.value;

  if(profileHasPasswordCache && !oldPassword){
    profileSecurityError.textContent = 'Masukkan password lama kamu.';
    return;
  }
  if(newPassword.length < 4){
    profileSecurityError.textContent = 'Password baru minimal 4 karakter.';
    return;
  }
  if(newPassword !== confirmPassword){
    profileSecurityError.textContent = 'Konfirmasi password baru tidak sama.';
    return;
  }

  profileSecurityError.textContent = '';
  profileSecuritySubmitBtn.disabled = true;
  profileSecuritySubmitBtn.textContent = 'Menyimpan...';

  const newHash = await sha256Hex(newPassword);
  const oldHash = profileHasPasswordCache ? await sha256Hex(oldPassword) : null;

  let result = null;
  try{
    const { data, error } = await sb.rpc('visitor_set_password', {
      input_username: name,
      input_new_password_hash: newHash,
      input_old_password_hash: oldHash
    });
    if(!error) result = data;
  }catch(e){ result = null; }

  profileSecuritySubmitBtn.disabled = false;

  if(result === 'ok'){
    profileSecurityError.className = 'gate-error';
    profileSecurityError.style.color = '#5fbf8e';
    profileSecurityError.textContent = profileHasPasswordCache ? 'Password berhasil diganti ✓' : 'Password berhasil dibuat ✓';
    renderProfileSecurity();
  } else if(result === 'wrong_password'){
    profileSecurityError.style.color = '';
    profileSecurityError.textContent = 'Password lama salah.';
    profileSecuritySubmitBtn.textContent = 'Ubah Password';
  } else {
    profileSecurityError.style.color = '';
    profileSecurityError.textContent = 'Gagal menyimpan password. Coba lagi.';
    profileSecuritySubmitBtn.textContent = profileHasPasswordCache ? 'Ubah Password' : 'Buat Password';
  }
});

profileCornerBtn.addEventListener('click', () => {
  profileModal.classList.add('active');
  renderProfilePayments();
  renderProfileSecurity();
  // Auto-refresh status tiap beberapa detik selagi modal profil terbuka,
  // supaya begitu admin approve, pengunjung langsung lihat perubahannya
  // tanpa perlu tutup-buka modal lagi.
  if(profilePaymentsPollInterval) clearInterval(profilePaymentsPollInterval);
  profilePaymentsPollInterval = setInterval(renderProfilePayments, 5000);
});
profileCloseBtn.addEventListener('click', () => {
  profileModal.classList.remove('active');
  if(profilePaymentsPollInterval){ clearInterval(profilePaymentsPollInterval); profilePaymentsPollInterval = null; }
});
profileModal.addEventListener('click', (e) => {
  if(e.target === profileModal){
    profileModal.classList.remove('active');
    if(profilePaymentsPollInterval){ clearInterval(profilePaymentsPollInterval); profilePaymentsPollInterval = null; }
  }
});
profileLogoutBtn.addEventListener('click', () => {
  profileModal.classList.remove('active');
  if(profilePaymentsPollInterval){ clearInterval(profilePaymentsPollInterval); profilePaymentsPollInterval = null; }
  logoutVisitor();
});

async function logoutVisitor(){
  if(heartbeatInterval){ clearInterval(heartbeatInterval); heartbeatInterval = null; }
  heartbeatName = null;
  if(forceLogoutWatchInterval){ clearInterval(forceLogoutWatchInterval); forceLogoutWatchInterval = null; }

  if(dbReady()){
    try{ await sb.from('active_players').delete().eq('session_id', getSessionId()); }catch(e){}
  }
  setCookie('visitorName', '', -1);
  setCookie('visitorLoginAt', '', -1);
  localStorage.removeItem('sessionId');
  hideUserBadge();
  path = [{ id: ROOT_FOLDER_ID, name: ROOT_FOLDER_LABEL }];
  foldersSection.style.display = 'none';
  videosSection.style.display = 'none';
  gateNameInput.value = '';
  gatePasswordInput.value = '';
  gateError.textContent = '';
  resetGateToNameStep();
  gateOverlay.style.display = 'flex';
  setTimeout(() => gateNameInput.focus(), 50);
}

const gateSubtitle = document.getElementById('gateSubtitle');
let gateAwaitingPassword = false; // true kalau sudah tahu akun ini butuh password, tinggal tunggu input password-nya

function resetGateToNameStep(){
  gateAwaitingPassword = false;
  gatePasswordInput.style.display = 'none';
  gatePasswordInput.value = '';
  gateNameInput.disabled = false;
  gateSubtitle.textContent = 'Masukkan nama kamu untuk melanjutkan.';
  gateSubmitBtn.textContent = 'Masuk';
}

async function submitName(){
  const name = gateNameInput.value.trim();

  if(!name){
    gateError.textContent = 'Nama tidak boleh kosong.';
    return;
  }
  if(name.toLowerCase() === 'admin'){
    gateError.textContent = '';
    gateOverlay.style.display = 'none';
    adminPwInput.value = '';
    adminPwError.textContent = '';
    adminPwModal.classList.add('active');
    setTimeout(() => adminPwInput.focus(), 50);
    return;
  }

  // TAHAP 1: baru masukkan nama, belum tahu apakah akun ini punya password.
  if(!gateAwaitingPassword){
    if(!dbReady()){
      // Tanpa Supabase, tidak ada cara cek password -> langsung masuk seperti dulu.
      setCookie('visitorName', name, 24 * 400);
      setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
      gateOverlay.style.display = 'none';
      showUserBadge(name);
      startHeartbeat(name);
      startForceLogoutWatch();
      loadCurrentFolder();
      return;
    }

    gateError.textContent = '';
    gateSubmitBtn.disabled = true;
    gateSubmitBtn.textContent = 'Memeriksa...';
    let hasPassword = false;
    try{
      const { data, error } = await sb.rpc('visitor_check_password', { input_username: name });
      if(!error) hasPassword = !!data;
    }catch(e){ hasPassword = false; }
    gateSubmitBtn.disabled = false;

    if(hasPassword){
      // Akun ini sudah pernah dibuatkan password lewat tab Profil -> minta sekarang.
      gateAwaitingPassword = true;
      gateNameInput.disabled = true;
      gatePasswordInput.style.display = 'block';
      gateSubtitle.textContent = `Akun "${name}" punya password. Masukkan untuk masuk.`;
      gateSubmitBtn.textContent = 'Masuk';
      setTimeout(() => gatePasswordInput.focus(), 50);
    } else {
      // Belum pernah bikin password -> langsung masuk seperti biasa.
      gateSubmitBtn.textContent = 'Masuk';
      setCookie('visitorName', name, 24 * 400);
      setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
      gateOverlay.style.display = 'none';
      showUserBadge(name);
      startHeartbeat(name);
      startForceLogoutWatch();
      loadCurrentFolder();
    }
    return;
  }

  // TAHAP 2: akun ini butuh password, verifikasi sekarang.
  const password = gatePasswordInput.value;
  if(!password){
    gateError.textContent = 'Password tidak boleh kosong.';
    return;
  }
  gateError.textContent = '';
  gateSubmitBtn.disabled = true;
  gateSubmitBtn.textContent = 'Memeriksa...';
  const passwordHash = await sha256Hex(password);
  let result = null;
  try{
    const { data, error } = await sb.rpc('visitor_verify_password', {
      input_username: name,
      input_password_hash: passwordHash
    });
    if(!error) result = data;
  }catch(e){ result = null; }
  gateSubmitBtn.disabled = false;
  gateSubmitBtn.textContent = 'Masuk';

  if(result === 'ok'){
    setCookie('visitorName', name, 24 * 400); // ~400 hari, batas maksimum browser modern
    setCookie('visitorLoginAt', String(Date.now()), 24 * 400);
    resetGateToNameStep();
    gateOverlay.style.display = 'none';
    showUserBadge(name);
    startHeartbeat(name);
    startForceLogoutWatch();
    loadCurrentFolder();
  } else if(result === 'wrong_password'){
    gateError.textContent = 'Password salah, coba lagi.';
    gatePasswordInput.value = '';
    gatePasswordInput.focus();
  } else {
    gateError.textContent = 'Gagal memeriksa akun. Coba lagi.';
  }
}
gateSubmitBtn.addEventListener('click', submitName);
gateNameInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitName(); });
gatePasswordInput.addEventListener('keydown', (e) => { if(e.key === 'Enter') submitName(); });

const existingVisitorName = getCookie('visitorName');
if(existingVisitorName){
  // Perpanjang lagi masa berlaku cookie setiap kali user buka halaman,
  // supaya selama user masih aktif kembali, login tidak akan pernah expired.
  setCookie('visitorName', existingVisitorName, 24 * 400);
  setCookie('visitorLoginAt', getCookie('visitorLoginAt') || '0', 24 * 400);
  gateOverlay.style.display = 'none';
  showUserBadge(existingVisitorName);
  // Cek kalau admin sudah menekan "Hapus Cache" sejak sesi login ini dibuat.
  startForceLogoutWatch();
} else {
  gateOverlay.style.display = 'flex';
  setTimeout(() => gateNameInput.focus(), 50);
}
