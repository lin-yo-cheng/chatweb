import { supabase } from './supabaseClient.js';
import { OWNER_UUID, OWNER_DISPLAY_NAME } from './config.js';
import {
  loadMessages,
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

const loadingView = document.getElementById('loading-view');
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');

const peerStatusEl = document.getElementById('peer-status');
const peerStatusDot = document.getElementById('peer-status-dot');
const peerStatusText = document.getElementById('peer-status-text');

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
const sendBtn = document.getElementById('send-btn');

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
  if (e.key === 'Enter' && !e.shiftKey) {
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

let isSending = false;

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThreadFriendId || isSending) return;

  const text = textInput.value.trim();
  const file = imageInput.files[0];
  const replyTo = replyingTo?.id ?? null;
  if (!text && !file) return;

  isSending = true;
  sendBtn.disabled = true;

  try {
    if (file) {
      await sendImageMessage(currentThreadFriendId, currentUser.id, file, replyTo);
      clearImagePreview();
    }
    if (text) {
      await sendTextMessage(currentThreadFriendId, currentUser.id, text, replyTo);
      textInput.value = '';
      textInput.style.height = 'auto';
    }
    clearReply();
  } catch (err) {
    alert('傳送失敗：' + err.message);
  } finally {
    isSending = false;
    sendBtn.disabled = false;
  }
});

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
  if (!document.hidden) {
    stopTitleFlash();
    markCurrentThreadReadIfActive();
  }
});

window.addEventListener('focus', markCurrentThreadReadIfActive);

function notify(title, body) {
  if (document.hidden) startTitleFlash();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification(title, { body });
  }
}

// ---------- Online presence ----------

function updateOnlineUI() {
  if (currentIsOwner) {
    friendItemsEl.querySelectorAll('.friend-item').forEach((item) => {
      const dot = item.querySelector('.status-dot');
      if (dot) dot.classList.toggle('online', onlineIds.has(item.dataset.friendId));
    });
  } else {
    peerStatusDot.classList.toggle('online', onlineIds.has(OWNER_UUID));
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
    peerStatusEl.classList.add('hidden');
    friendListEl.classList.remove('hidden');
    panelDivider.classList.remove('hidden');
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (savedWidth) friendListEl.style.width = savedWidth;
    setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true', false);
    await renderFriendList();
    ownerInboxChannel = subscribeToOwnerInbox(handleOwnerInboxInsert);
  } else {
    friendListEl.classList.add('hidden');
    setSidebarCollapsed(true, false);
    peerStatusEl.classList.remove('hidden');
    peerStatusText.textContent = OWNER_DISPLAY_NAME;
    const { data: myRow } = await supabase
      .from('friends')
      .select('*')
      .eq('id', user.id)
      .single();
    await openThread(user.id, myRow?.background_image);
  }
}

async function handleOwnerInboxInsert(row) {
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

async function openThread(friendId, backgroundImage) {
  if (currentChannel) {
    unsubscribeFromThread(currentChannel);
    currentChannel = null;
  }

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

  const peerId = currentIsOwner ? friendId : OWNER_UUID;
  const [rows, readStates] = await Promise.all([loadMessages(friendId), getReadStates(friendId)]);

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

    const node = await renderMessageNode(row, currentUser.id, currentIsOwner, {
      repliedRow: row.reply_to ? messageMap.get(row.reply_to) : null,
      onReply: setReply,
    });
    messageListEl.appendChild(node);
  }
  scrollToBottom();
  updateReadReceipt();

  if (isPageActive()) {
    markThreadRead(friendId, currentUser.id).catch(() => {});
  }

  currentChannel = subscribeToThread(friendId, {
    onInsert: async (row) => {
      messageMap.set(row.id, row);
      const node = await renderMessageNode(row, currentUser.id, currentIsOwner, {
        repliedRow: row.reply_to ? messageMap.get(row.reply_to) : null,
        onReply: setReply,
      });
      messageListEl.appendChild(node);
      scrollToBottom();

      if (row.sender_id !== currentUser.id) {
        const senderName = currentIsOwner ? (friendDisplayNames.get(friendId) ?? '朋友') : OWNER_DISPLAY_NAME;
        notify(senderName, '傳來一則新訊息');
        if (isPageActive()) {
          markThreadRead(friendId, currentUser.id).catch(() => {});
        }
      }
    },
    onDelete: (row) => {
      messageMap.delete(row.id);
      const node = messageListEl.querySelector(`[data-message-id="${row.id}"]`);
      if (node) node.remove();
    },
    onReadStateChange: (state) => {
      if (state.reader_id !== peerId) return;
      peerLastReadAt = state.last_read_at;
      updateReadReceipt();
    },
    onTyping: (senderId) => {
      if (senderId === currentUser.id) return;
      showTypingIndicator();
    },
  });
}

function updateReadReceipt() {
  const rows = messageListEl.querySelectorAll('.msg-row.mine');
  if (!rows.length) return;
  const lastRow = rows[rows.length - 1];
  const receipt = lastRow.querySelector('.read-receipt');
  if (!receipt) return;

  const row = messageMap.get(lastRow.dataset.messageId);
  if (row && peerLastReadAt && peerLastReadAt >= row.created_at) {
    receipt.textContent = '已讀';
  } else {
    receipt.textContent = '';
  }
}

function scrollToBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

// ---------- Panel size persistence ----------

const SIZE_KEY = 'chatweb-panel-size';

(() => {
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
