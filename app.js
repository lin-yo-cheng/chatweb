import { supabase } from './supabaseClient.js';
import { OWNER_UUID, OWNER_DISPLAY_NAME } from './config.js';
import {
  loadMessages,
  loadMessagesSince,
  loadLatestMessageMeta,
  loadInboxSince,
  sendTextMessage,
  sendImageMessage,
  subscribeToThread,
  subscribeToOwnerInbox,
  unsubscribeFromThread,
  broadcastTyping,
  renderMessageNode,
  markThreadRead,
  getReadStates,
  getMyReadStates,
  getUnreadCount,
  quoteSnippet,
} from './chat.js';
import { trackPresence, subscribeOnlineUsers } from './presence.js';
import { logConn } from './connlog.js';

const loadingView = document.getElementById('loading-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');

const headerPeerInfo = document.getElementById('header-peer-info');
const headerPeerDot = document.getElementById('header-peer-dot');
const headerPeerName = document.getElementById('header-peer-name');

const ownerInfoPanel = document.getElementById('owner-info-panel');
const ownerInfoDot = document.getElementById('owner-info-dot');
const ownerInfoName = document.getElementById('owner-info-name');

const mainAreaEl = document.getElementById('main-area');
const friendListEl = document.getElementById('friend-list');
const filterBtn = document.getElementById('filter-btn');
const collapseBtn = document.getElementById('collapse-btn');
const filterPanel = document.getElementById('filter-panel');
const friendItemsEl = document.getElementById('friend-items');
const panelDivider = document.getElementById('panel-divider');
const chatPanelHeader = document.getElementById('chat-panel-header');
const showListBtn = document.getElementById('show-list-btn');
const chatPlaceholder = document.getElementById('chat-placeholder');
const chatBody = document.getElementById('chat-body');
const chatBackground = document.getElementById('chat-background');
const chatBackgroundVideo = document.getElementById('chat-background-video');
const chatBackgroundFade = document.getElementById('chat-background-fade');
const messageListEl = document.getElementById('message-list');

const imagePreview = document.getElementById('image-preview');
const imagePreviewImg = document.getElementById('image-preview-img');
const imagePreviewName = document.getElementById('image-preview-name');
const imagePreviewCancel = document.getElementById('image-preview-cancel');
const imageLightbox = document.getElementById('image-lightbox');
const imageLightboxImg = document.getElementById('image-lightbox-img');

const replyPreview = document.getElementById('reply-preview');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancelBtn = document.getElementById('reply-cancel-btn');
const typingIndicatorEl = document.getElementById('typing-indicator');

const composer = document.getElementById('composer');
const textInput = document.getElementById('text-input');
const imageInput = document.getElementById('image-input');

const ORIGINAL_TITLE = document.title;

let currentUser = null;
let currentIsOwner = false;
let currentThreadFriendId = null;
let currentChannel = null;
let ownerInboxChannel = null;

let messageMap = new Map();
let replyingTo = null; // { id, snippet }
let peerLastReadAt = null;
let friendDisplayNames = new Map();
let onlineIds = new Set();
let titleFlashTimer = null;
let allFriends = [];

function isMobile() {
  return window.matchMedia('(max-width: 640px)').matches;
}

// 觸控裝置（沒有實體鍵盤/Shift 鍵）判斷，跟視窗寬度無關——
// 電腦把視窗縮小依然是滑鼠鍵盤操作，Enter 應該正常送出
function isTouchDevice() {
  return window.matchMedia('(pointer: coarse)').matches;
}

// ---------- Login / logout ----------

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.textContent = '';
  loginBtn.disabled = true;

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  loginBtn.disabled = false;

  if (error) {
    loginError.textContent = '登入失敗，請檢查帳號密碼';
    return;
  }

  await initApp(data.user);
});

logoutBtn.addEventListener('click', async () => {
  await supabase.auth.signOut();
  // 整頁重新整理，確保上一個帳號的所有殘留狀態（訂閱、進行中的讀取）都被清乾淨，
  // 不會在切換帳號時互相污染畫面
  location.reload();
});

// ---------- Composer: reply + send + Enter-to-send ----------

textInput.addEventListener('keydown', (e) => {
  // 觸控裝置沒有 Shift 鍵可以配合換行，Enter 一律當作換行，送出訊息一定要按送出鈕；
  // 電腦不管視窗多窄都還是鍵盤滑鼠操作，Enter 照常送出
  if (e.key === 'Enter' && !e.shiftKey && !isTouchDevice()) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

let lastTypingSentAt = 0;

textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';

  const now = Date.now();
  if (currentChannel && now - lastTypingSentAt > 1500) {
    lastTypingSentAt = now;
    broadcastTyping(currentChannel, currentUser.id);
  }
});

let typingTimeout = null;

function showTypingIndicator() {
  const name = currentIsOwner ? (friendDisplayNames.get(currentThreadFriendId) ?? '對方') : OWNER_DISPLAY_NAME;
  typingIndicatorEl.textContent = `${name} 正在輸入…`;
  typingIndicatorEl.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    typingIndicatorEl.classList.add('hidden');
  }, 3000);
}

function hideTypingIndicator() {
  clearTimeout(typingTimeout);
  typingIndicatorEl.classList.add('hidden');
}

replyCancelBtn.addEventListener('click', () => {
  clearReply();
});

function setReply(row) {
  replyingTo = { id: row.id, snippet: quoteSnippet(row) };
  replyPreviewText.textContent = replyingTo.snippet;
  replyPreview.classList.remove('hidden');
  textInput.focus();
}

function clearReply() {
  replyingTo = null;
  replyPreview.classList.add('hidden');
}

let imagePreviewUrl = null;

function setSelectedImageFile(file) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  imageInput.files = dataTransfer.files;
  imageInput.dispatchEvent(new Event('change'));
}

textInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) setSelectedImageFile(file);
      break;
    }
  }
});

imageInput.addEventListener('change', () => {
  const file = imageInput.files[0];
  if (imagePreviewUrl) URL.revokeObjectURL(imagePreviewUrl);

  if (!file) {
    imagePreview.classList.add('hidden');
    return;
  }

  imagePreviewUrl = URL.createObjectURL(file);
  imagePreviewImg.src = imagePreviewUrl;
  imagePreviewName.textContent = file.name;
  imagePreview.classList.remove('hidden');
});

function clearImagePreview() {
  imageInput.value = '';
  if (imagePreviewUrl) {
    URL.revokeObjectURL(imagePreviewUrl);
    imagePreviewUrl = null;
  }
  imagePreview.classList.add('hidden');
}

imagePreviewCancel.addEventListener('click', () => {
  clearImagePreview();
});

messageListEl.addEventListener('click', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.bubble')) {
    imageLightboxImg.src = e.target.src;
    imageLightbox.classList.remove('hidden');
  }
});

imageLightbox.addEventListener('click', () => {
  imageLightbox.classList.add('hidden');
  imageLightboxImg.src = '';
});

// 送出時「當下」就取出內容並清空輸入框：
// - 連按 Enter 時第二次輸入框已經是空的，不會重複送出
// - 網路慢的時候可以繼續打下一則，不會被鎖住或在送出完成時被一起清掉
// 實際傳送排進佇列，依序執行（避免兩則訊息在網路上互相超車、順序錯亂），
// 傳送失敗才把內容放回輸入框。
let sendQueue = Promise.resolve();

composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!currentThreadFriendId) return;

  const text = textInput.value.trim();
  const file = imageInput.files[0];
  const reply = replyingTo;
  if (!text && !file) return;

  // 送出當下就固定好對象，之後就算切換聊天室也不會送錯人
  const friendId = currentThreadFriendId;
  const senderId = currentUser.id;

  textInput.value = '';
  textInput.style.height = 'auto';
  if (file) clearImagePreview();
  clearReply();

  sendQueue = sendQueue.then(async () => {
    let failedStep = null;
    try {
      if (file) {
        failedStep = 'image';
        await sendImageMessage(friendId, senderId, file, reply?.id ?? null);
      }
      if (text) {
        failedStep = 'text';
        await sendTextMessage(friendId, senderId, text, reply?.id ?? null);
      }
    } catch (err) {
      alert('傳送失敗：' + err.message);
      restoreUnsent(failedStep === 'image' ? { text, file, reply } : { text, reply });
    }
  });
});

// 傳送失敗時把沒送出去的內容放回輸入框（輸入框已經有新內容的話，接在前面不蓋掉）
function restoreUnsent({ text, file, reply }) {
  if (text) {
    textInput.value = textInput.value ? `${text}\n${textInput.value}` : text;
    textInput.dispatchEvent(new Event('input'));
  }
  if (file && !imageInput.files[0]) setSelectedImageFile(file);
  if (reply && !replyingTo) {
    replyingTo = reply;
    replyPreviewText.textContent = reply.snippet;
    replyPreview.classList.remove('hidden');
  }
}

// ---------- Notifications ----------

function startTitleFlash() {
  if (titleFlashTimer) return;
  let flashOn = false;
  titleFlashTimer = setInterval(() => {
    document.title = flashOn ? ORIGINAL_TITLE : '💬 新訊息';
    flashOn = !flashOn;
  }, 1000);
}

function stopTitleFlash() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
  }
  document.title = ORIGINAL_TITLE;
}

function isPageActive() {
  return !document.hidden && document.hasFocus();
}

function markCurrentThreadReadIfActive() {
  if (currentThreadFriendId && isPageActive()) {
    markThreadRead(currentThreadFriendId, currentUser.id).catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => {
  logConn('visibility', document.hidden ? 'hidden' : 'visible');
  if (!document.hidden) {
    stopTitleFlash();
    markCurrentThreadReadIfActive();
    syncThread('visible', true);
    checkInbox('visible');
  }
});

window.addEventListener('focus', () => {
  markCurrentThreadReadIfActive();
  syncThread('focus', true);
});

window.addEventListener('online', () => {
  logConn('network', 'online');
  syncThread('online', true);
  checkInbox('online');
});

window.addEventListener('offline', () => logConn('network', 'offline'));

function notify(title, body) {
  if (document.hidden) startTitleFlash();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

// 補抓到漏掉的訊息時，一個對話只跳一則摘要通知，不會一次跳好幾則
function summaryBody(count) {
  return count === 1 ? '傳來一則新訊息' : `傳來 ${count} 則新訊息`;
}

// ---------- Online presence ----------

function updateOnlineUI() {
  if (currentIsOwner) {
    friendItemsEl.querySelectorAll('.friend-item').forEach((item) => {
      const dot = item.querySelector('.status-dot');
      if (dot) dot.classList.toggle('online', onlineIds.has(item.dataset.friendId));
    });
    if (currentThreadFriendId) {
      headerPeerDot.classList.toggle('online', onlineIds.has(currentThreadFriendId));
    }
  } else {
    ownerInfoDot.classList.toggle('online', onlineIds.has(OWNER_UUID));
    headerPeerDot.classList.toggle('online', onlineIds.has(OWNER_UUID));
  }
}

// ---------- Sidebar: collapse, resize divider, filter panel ----------

const SIDEBAR_COLLAPSED_KEY = 'chatweb-sidebar-collapsed';
const SIDEBAR_WIDTH_KEY = 'chatweb-sidebar-width';
const HIDDEN_FRIENDS_KEY = 'chatweb-hidden-friends';

function loadHiddenFriendIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_FRIENDS_KEY)) || []);
  } catch {
    return new Set();
  }
}

let hiddenFriendIds = loadHiddenFriendIds();

function setSidebarCollapsed(collapsed, persist) {
  mainAreaEl.classList.toggle('sidebar-collapsed', collapsed);
  if (currentIsOwner) {
    chatPanelHeader.classList.toggle('hidden', !collapsed);
  }
  if (persist) localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
}

collapseBtn.addEventListener('click', () => setSidebarCollapsed(true, true));
showListBtn.addEventListener('click', () => setSidebarCollapsed(false, true));

filterBtn.addEventListener('click', () => {
  filterPanel.classList.toggle('hidden');
});

function renderFilterPanel() {
  filterPanel.innerHTML = '';
  for (const friend of allFriends) {
    const row = document.createElement('label');
    row.className = 'filter-row';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenFriendIds.has(friend.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) hiddenFriendIds.delete(friend.id);
      else hiddenFriendIds.add(friend.id);
      localStorage.setItem(HIDDEN_FRIENDS_KEY, JSON.stringify([...hiddenFriendIds]));
      renderFriendItems();
    });

    const name = document.createElement('span');
    name.textContent = friend.display_name;

    row.appendChild(checkbox);
    row.appendChild(name);
    filterPanel.appendChild(row);
  }
}

let dividerDragging = false;

panelDivider.addEventListener('mousedown', (e) => {
  dividerDragging = true;
  panelDivider.classList.add('dragging');
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!dividerDragging) return;
  const rect = mainAreaEl.getBoundingClientRect();
  const width = Math.max(120, Math.min(360, e.clientX - rect.left));
  friendListEl.style.width = width + 'px';
});

document.addEventListener('mouseup', () => {
  if (!dividerDragging) return;
  dividerDragging = false;
  panelDivider.classList.remove('dragging');
  localStorage.setItem(SIDEBAR_WIDTH_KEY, friendListEl.style.width);
});

// ---------- App init ----------

async function initApp(user) {
  currentUser = user;
  loadingView.classList.add('hidden');
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');

  currentIsOwner = user.id === OWNER_UUID;

  if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  trackPresence(user.id);
  subscribeOnlineUsers((ids) => {
    onlineIds = ids;
    updateOnlineUI();
  });

  if (currentIsOwner) {
    ownerInfoPanel.classList.add('hidden');
    headerPeerInfo.classList.add('hidden');
    friendListEl.classList.remove('hidden');
    panelDivider.classList.remove('hidden');
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (savedWidth) friendListEl.style.width = savedWidth;
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true', false);
    // 先記下目前最新一則訊息的時間點，之後的「定期檢查」只看這個時間點之後的新訊息
    const latest = await loadLatestMessageMeta().catch(() => null);
    inboxCursor = latest?.created_at ?? null;
    if (latest) rememberInboxId(latest.id); // 邊界那一則登入前就存在，不算新訊息
    await renderFriendList();
    ownerInboxChannel = subscribeToOwnerInbox(handleOwnerInboxInsert, (status) => {
      logConn('inbox-channel', status);
      if (status === 'SUBSCRIBED') checkInbox('subscribed');
    });
  } else {
    friendListEl.classList.add('hidden');
    setSidebarCollapsed(true, false);
    ownerInfoPanel.classList.remove('hidden');
    ownerInfoName.textContent = OWNER_DISPLAY_NAME;
    headerPeerInfo.classList.remove('hidden');
    headerPeerName.textContent = OWNER_DISPLAY_NAME;
    const { data: myRow } = await supabase
      .from('friends')
      .select('*')
      .eq('id', user.id)
      .single();
    await openThread(user.id, myRow?.background_image);
  }

  startPolling();
}

// ---------- Owner inbox（其他對話串的新訊息：未讀數字 + 通知）----------

let inboxCursor = null; // 上次檢查時看到的最新訊息時間（資料庫原始字串）
let inboxChecking = false;
const seenInboxIds = new Set(); // 已經處理過的訊息 ID，避免即時推送和定期檢查重複處理

function rememberInboxId(id) {
  seenInboxIds.add(id);
  if (seenInboxIds.size > 1000) {
    const iterator = seenInboxIds.values();
    for (let i = 0; i < 500; i++) seenInboxIds.delete(iterator.next().value);
  }
}

async function handleOwnerInboxInsert(row) {
  if (seenInboxIds.has(row.id)) return;
  rememberInboxId(row.id);

  if (row.sender_id === currentUser.id) return;
  if (row.friend_id === currentThreadFriendId) return; // already handled by the open thread's own subscription

  notify(friendDisplayNames.get(row.friend_id) ?? '朋友', '傳來一則新訊息');

  const friend = allFriends.find((f) => f.id === row.friend_id);
  if (friend) friend.unread = (friend.unread || 0) + 1;

  const item = friendItemsEl.querySelector(`[data-friend-id="${row.friend_id}"]`);
  if (item) {
    const badge = item.querySelector('.unread-badge');
    badge.textContent = String(friend?.unread ?? 1);
    badge.classList.remove('hidden');
  }
}

// 重新向資料庫計算指定朋友的未讀數並更新徽章（用資料庫的數字為準，不用累加）
async function refreshUnreadFor(friendIds) {
  const states = await getMyReadStates(OWNER_UUID);
  const lastReadByFriend = new Map(states.map((s) => [s.friend_id, s.last_read_at]));

  for (const fid of friendIds) {
    const friend = allFriends.find((f) => f.id === fid);
    if (!friend) continue;

    friend.unread = await getUnreadCount(fid, lastReadByFriend.get(fid) ?? null, OWNER_UUID);
    const badge = friendItemsEl.querySelector(`[data-friend-id="${fid}"] .unread-badge`);
    if (badge) {
      badge.textContent = String(friend.unread);
      badge.classList.toggle('hidden', friend.unread <= 0);
    }
  }
}

// 定期檢查／重連／切回前景時呼叫：補抓即時推送漏掉的其他對話串訊息
async function checkInbox(reason) {
  if (!currentIsOwner || !currentUser || inboxChecking) return;
  inboxChecking = true;

  try {
    const rows = await loadInboxSince(inboxCursor);
    if (rows.length) inboxCursor = rows[rows.length - 1].created_at;

    const foundByFriend = new Map();
    for (const row of rows) {
      if (seenInboxIds.has(row.id)) continue;
      rememberInboxId(row.id);
      if (row.sender_id === currentUser.id) continue;
      if (row.friend_id === currentThreadFriendId) continue; // 目前開著的對話串由 syncThread 處理
      foundByFriend.set(row.friend_id, (foundByFriend.get(row.friend_id) ?? 0) + 1);
    }

    if (foundByFriend.size) {
      logConn('inbox-found', `${reason}: ${[...foundByFriend.values()].reduce((a, b) => a + b, 0)} 則`);
      await refreshUnreadFor([...foundByFriend.keys()]);
      for (const [friendId, count] of foundByFriend) {
        notify(friendDisplayNames.get(friendId) ?? '朋友', summaryBody(count));
      }
    }
  } catch (err) {
    logConn('inbox-error', err.message);
  } finally {
    inboxChecking = false;
  }
}

async function renderFriendList() {
  const { data, error } = await supabase.from('friends').select('*').order('display_name');

  if (error) {
    friendItemsEl.textContent = '朋友名單載入失敗';
    return;
  }

  const myReadStates = await getMyReadStates(OWNER_UUID);
  const lastReadByFriend = new Map(myReadStates.map((s) => [s.friend_id, s.last_read_at]));

  allFriends = [];
  for (const friend of data) {
    friendDisplayNames.set(friend.id, friend.display_name);
    const unread = await getUnreadCount(friend.id, lastReadByFriend.get(friend.id) ?? null, OWNER_UUID);
    allFriends.push({ ...friend, unread });
  }

  renderFilterPanel();
  renderFriendItems();
}

function renderFriendItems() {
  friendItemsEl.innerHTML = '';

  for (const friend of allFriends) {
    if (hiddenFriendIds.has(friend.id)) continue;

    const item = document.createElement('div');
    item.className = 'friend-item' + (friend.id === currentThreadFriendId ? ' active' : '');
    item.dataset.friendId = friend.id;

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = friend.display_name;
    item.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'unread-badge' + (friend.unread > 0 ? '' : ' hidden');
    badge.textContent = String(friend.unread);
    item.appendChild(badge);

    item.addEventListener('click', () => {
      document.querySelectorAll('.friend-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
      friend.unread = 0;
      badge.textContent = '0';
      badge.classList.add('hidden');
      if (isMobile()) setSidebarCollapsed(true, false);
      openThread(friend.id, friend.background_image);
    });

    friendItemsEl.appendChild(item);
  }

  updateOnlineUI();
}

// ---------- Background (image or looping video) ----------

function applyBackground(path) {
  chatBackgroundVideo.pause();
  chatBackgroundVideo.removeAttribute('src');
  chatBackgroundVideo.load();
  chatBackgroundVideo.classList.add('hidden');
  chatBackground.classList.remove('hidden');
  chatBackground.style.backgroundImage = 'none';
  chatBackgroundFade.classList.add('hidden');

  if (!path) return;

  chatBackgroundFade.classList.remove('hidden');

  if (/\.(mp4|webm)$/i.test(path)) {
    chatBackground.classList.add('hidden');
    chatBackgroundVideo.classList.remove('hidden');
    chatBackgroundVideo.src = path;
    chatBackgroundVideo.play().catch(() => {});
  } else {
    chatBackground.style.backgroundImage = `url('${path}')`;
  }
}

// ---------- Thread ----------

let threadToken = 0;
let threadReady = false; // 目前對話串的歷史訊息是否載入完成（載入中不做補抓，避免重複插入）

function latestKnownCreatedAt() {
  let latest = null;
  let latestTime = -Infinity;
  for (const row of messageMap.values()) {
    const time = new Date(row.created_at).getTime();
    if (time > latestTime) {
      latestTime = time;
      latest = row.created_at; // 保留資料庫原始字串（含微秒）
    }
  }
  return latest;
}

// 依訊息時間插入到正確位置（即時推送、補抓的訊息到達順序不一定等於時間順序）
function insertMessageNode(node, row) {
  const time = new Date(row.created_at).getTime();
  const rows = messageListEl.querySelectorAll('.msg-row');

  for (let i = rows.length - 1; i >= 0; i--) {
    const other = messageMap.get(rows[i].dataset.messageId);
    if (other && new Date(other.created_at).getTime() <= time) {
      rows[i].after(node);
      return;
    }
  }

  const first = messageListEl.querySelector('.msg-row');
  if (first) first.before(node);
  else messageListEl.appendChild(node);
}

function buildMessageNode(row) {
  return renderMessageNode(row, currentUser.id, currentIsOwner, {
    repliedRow: row.reply_to ? messageMap.get(row.reply_to) : null,
    onReply: setReply,
  });
}

async function replaceMessageNode(row, token) {
  const oldNode = messageListEl.querySelector(`[data-message-id="${row.id}"]`);
  if (!oldNode) return;
  const newNode = await buildMessageNode(row);
  if (token !== threadToken) return;
  oldNode.replaceWith(newNode);
}

async function openThread(friendId, backgroundImage) {
  const myToken = ++threadToken;
  threadReady = false;

  if (currentChannel) {
    await unsubscribeFromThread(currentChannel);
    currentChannel = null;
  }
  if (myToken !== threadToken) return; // 切換到別的對話串了，這次呼叫作廢

  currentThreadFriendId = friendId;
  clearReply();
  clearImagePreview();
  hideTypingIndicator();
  chatPlaceholder.classList.add('hidden');
  chatBody.classList.remove('hidden');
  composer.classList.remove('hidden');
  messageListEl.innerHTML = '';
  messageMap = new Map();

  applyBackground(backgroundImage);

  if (currentIsOwner) {
    headerPeerInfo.classList.remove('hidden');
    headerPeerName.textContent = friendDisplayNames.get(friendId) ?? '';
    headerPeerDot.classList.toggle('online', onlineIds.has(friendId));
  }

  const peerId = currentIsOwner ? friendId : OWNER_UUID;

  let rows;
  let readStates;
  try {
    [rows, readStates] = await Promise.all([loadMessages(friendId), getReadStates(friendId)]);
  } catch (err) {
    // 開啟時剛好網路不穩：不要停在一片空白，幾秒後自動重試
    logConn('thread-load-error', err.message);
    setTimeout(() => {
      if (myToken === threadToken) openThread(friendId, backgroundImage);
    }, 5000);
    return;
  }
  if (myToken !== threadToken) return; // 切換到別的對話串了，這次呼叫作廢

  const myOldLastRead = readStates.find((s) => s.reader_id === currentUser.id)?.last_read_at ?? null;
  peerLastReadAt = readStates.find((s) => s.reader_id === peerId)?.last_read_at ?? null;

  let dividerPlaced = false;
  for (const row of rows) {
    messageMap.set(row.id, row);

    if (!dividerPlaced && myOldLastRead && row.sender_id !== currentUser.id && row.created_at > myOldLastRead) {
      const divider = document.createElement('div');
      divider.className = 'unread-divider';
      divider.textContent = '以下訊息未讀';
      messageListEl.appendChild(divider);
      dividerPlaced = true;
    }

    const node = await buildMessageNode(row);
    if (myToken !== threadToken) return; // 切換到別的對話串了，這次呼叫作廢
    messageListEl.appendChild(node);
  }
  scrollToBottom();
  updateReadReceipt();

  if (isPageActive()) {
    markThreadRead(friendId, currentUser.id).catch(() => {});
  }

  threadReady = true;

  currentChannel = subscribeToThread(friendId, {
    onInsert: async (row) => {
      if (myToken !== threadToken) return;
      if (messageMap.has(row.id)) return; // 已經被補抓機制加進來了
      messageMap.set(row.id, row);
      const node = await buildMessageNode(row);
      if (myToken !== threadToken) return;
      if (messageListEl.querySelector(`[data-message-id="${row.id}"]`)) return;
      insertMessageNode(node, row);
      scrollToBottom();
      updateReadReceipt();

      if (row.sender_id !== currentUser.id) {
        const senderName = currentIsOwner ? (friendDisplayNames.get(friendId) ?? '朋友') : OWNER_DISPLAY_NAME;
        notify(senderName, '傳來一則新訊息');
        if (isPageActive()) {
          markThreadRead(friendId, currentUser.id).catch(() => {});
        }
      }
    },
    onUpdate: async (row) => {
      if (myToken !== threadToken) return;
      messageMap.set(row.id, row);
      await replaceMessageNode(row, myToken);
      updateReadReceipt(); // 重新繪製的訊息泡泡會丟掉「已讀」字樣，要補回去
    },
    onDelete: (row) => {
      if (myToken !== threadToken) return;
      messageMap.delete(row.id);
      const node = messageListEl.querySelector(`[data-message-id="${row.id}"]`);
      if (node) node.remove();
      updateReadReceipt();
    },
    onReadStateChange: (state) => {
      if (myToken !== threadToken) return;
      if (state.reader_id !== peerId) return;
      peerLastReadAt = state.last_read_at;
      updateReadReceipt();
    },
    onTyping: (senderId) => {
      if (myToken !== threadToken) return;
      if (senderId === currentUser.id) return;
      showTypingIndicator();
    },
    onStatus: (status) => {
      if (myToken !== threadToken) return;
      logConn('thread-channel', status);
      // 連線建立（包含斷線後重連）就補抓一次：涵蓋「讀完歷史到接上即時連線之間」以及斷線期間漏掉的訊息
      if (status === 'SUBSCRIBED') syncThread('subscribed', true);
    },
  });
}

// ---------- 補抓：即時推送漏掉的訊息 ----------
// 即時推送（WebSocket）斷線期間的訊息不會補發。這裡在「連線建立/重連、切回前景、網路恢復、
// 定期檢查」時，主動向資料庫確認有沒有漏掉的訊息；light 只抓新訊息，full 會完整比對
// （包含被刪除、被編輯的訊息）。

let syncing = false;
let syncAgain = null; // 同步進行中又被要求時，記下來，做完再補跑一次

async function syncThread(reason, full) {
  if (!currentUser || !currentThreadFriendId || !threadReady) return;

  if (syncing) {
    syncAgain = { reason, full: full || syncAgain?.full === true };
    return;
  }
  syncing = true;

  const friendId = currentThreadFriendId;
  const token = threadToken;
  const peerId = currentIsOwner ? friendId : OWNER_UUID;

  try {
    // 開始查詢「之前」就已經在畫面上的訊息：只有這些訊息才能判定為「已被刪除」，
    // 查詢期間剛由即時推送加進來的訊息不會被誤刪
    const knownBefore = new Set(messageMap.keys());
    const since = full ? null : latestKnownCreatedAt();

    const [rows, readStates] = await Promise.all([
      since ? loadMessagesSince(friendId, since) : loadMessages(friendId),
      getReadStates(friendId),
    ]);
    if (token !== threadToken || friendId !== currentThreadFriendId) return;

    let changed = false;

    // 對方的已讀進度只往前推
    const peerRead = readStates.find((s) => s.reader_id === peerId)?.last_read_at ?? null;
    if (peerRead && (!peerLastReadAt || new Date(peerRead) > new Date(peerLastReadAt))) {
      peerLastReadAt = peerRead;
      changed = true;
    }

    let addedCount = 0;
    const addedFromOthers = [];

    for (const row of rows) {
      const existing = messageMap.get(row.id);

      if (existing) {
        if (full && (existing.content !== row.content || existing.edited_at !== row.edited_at)) {
          messageMap.set(row.id, row);
          await replaceMessageNode(row, token);
          changed = true;
        }
        continue;
      }

      messageMap.set(row.id, row);
      const node = await buildMessageNode(row);
      if (token !== threadToken) return;
      if (!messageListEl.querySelector(`[data-message-id="${row.id}"]`)) insertMessageNode(node, row);
      addedCount++;
      if (row.sender_id !== currentUser.id) addedFromOthers.push(row);
    }

    let removedCount = 0;
    if (full) {
      const serverIds = new Set(rows.map((row) => row.id));
      for (const id of knownBefore) {
        if (serverIds.has(id) || !messageMap.has(id)) continue;
        messageMap.delete(id);
        messageListEl.querySelector(`[data-message-id="${id}"]`)?.remove();
        removedCount++;
      }
    }

    if (addedCount || removedCount || changed) updateReadReceipt();

    if (addedCount) {
      scrollToBottom();
      logConn('sync-found', `${reason}: 補抓到 ${addedCount} 則`);

      if (addedFromOthers.length) {
        if (isPageActive()) {
          markThreadRead(friendId, currentUser.id).catch(() => {});
        } else {
          const senderName = currentIsOwner ? (friendDisplayNames.get(friendId) ?? '朋友') : OWNER_DISPLAY_NAME;
          notify(senderName, summaryBody(addedFromOthers.length));
        }
      }
    }
    if (removedCount) logConn('sync-removed', `${reason}: 移除 ${removedCount} 則`);
  } catch (err) {
    logConn('sync-error', `${reason}: ${err.message}`);
  } finally {
    syncing = false;
    if (syncAgain) {
      const next = syncAgain;
      syncAgain = null;
      syncThread(next.reason, next.full);
    }
  }
}

// ---------- 定期檢查 ----------
// 即時連線因為任何原因無聲壞掉時的保險：每 25 秒只問一次「有沒有新訊息」（資料量很小），
// 每 5 次（約 2 分鐘）做一次完整比對。

const POLL_INTERVAL_MS = 25000;
const FULL_SYNC_EVERY = 5;
let pollTimer = null;
let pollCount = 0;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!navigator.onLine) return;
    pollCount++;
    syncThread('poll', pollCount % FULL_SYNC_EVERY === 0);
    checkInbox('poll');
  }, POLL_INTERVAL_MS);
}

// 已讀只顯示在「對方最後看過的那一則我傳的訊息」上，
// 之後我再傳新訊息，已讀會停留在原本那一則，不會跟著消失
function updateReadReceipt() {
  const peerReadTime = peerLastReadAt ? new Date(peerLastReadAt).getTime() : null;
  let lastReadReceipt = null;

  messageListEl.querySelectorAll('.msg-row.mine').forEach((el) => {
    const receipt = el.querySelector('.read-receipt');
    if (!receipt) return;
    receipt.textContent = '';

    const row = messageMap.get(el.dataset.messageId);
    if (peerReadTime !== null && row && new Date(row.created_at).getTime() <= peerReadTime) {
      lastReadReceipt = receipt;
    }
  });

  if (lastReadReceipt) lastReadReceipt.textContent = '已讀';
}

function scrollToBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

// ---------- Panel size persistence ----------

const SIZE_KEY = 'chatweb-panel-size';

(() => {
  // 手機版一律滿版鋪開，不套用「記住大小」這個桌面版才有意義的機制，
  // 也順便清掉任何殘留的 inline 尺寸，避免卡在轉橫向/直向時記錄到的錯誤尺寸
  if (isMobile()) {
    appView.style.width = '';
    appView.style.height = '';
    return;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SIZE_KEY));
    if (saved?.width && saved?.height) {
      appView.style.width = saved.width + 'px';
      appView.style.height = saved.height + 'px';
    }
  } catch {
    // ignore malformed/missing saved size
  }
})();

new ResizeObserver(() => {
  if (isMobile()) return;
  localStorage.setItem(
    SIZE_KEY,
    JSON.stringify({ width: appView.offsetWidth, height: appView.offsetHeight })
  );
}).observe(appView);

// 進站時如果已經有登入 session 就直接進 app，不用重新輸入密碼；
// 確認前先顯示 loading 畫面，避免閃過一下登入頁再跳轉
const { data: { session } } = await supabase.auth.getSession();
if (session) {
  await initApp(session.user);
} else {
  loadingView.classList.add('hidden');
  loginView.classList.remove('hidden');
}
