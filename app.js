import { supabase } from './supabaseClient.js';
import { OWNER_UUID } from './config.js';
import {
  loadMessages,
  sendTextMessage,
  sendImageMessage,
  subscribeToThread,
  subscribeToOwnerInbox,
  unsubscribeFromThread,
  renderMessageNode,
  markThreadRead,
  getReadStates,
  getMyReadStates,
  getUnreadCount,
  quoteSnippet,
} from './chat.js';
import { trackPresence, subscribeOnlineUsers } from './presence.js';

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');

const peerStatusEl = document.getElementById('peer-status');
const peerStatusDot = document.getElementById('peer-status-dot');
const peerStatusText = document.getElementById('peer-status-text');

const friendListEl = document.getElementById('friend-list');
const chatPlaceholder = document.getElementById('chat-placeholder');
const chatBody = document.getElementById('chat-body');
const chatBackground = document.getElementById('chat-background');
const chatBackgroundVideo = document.getElementById('chat-background-video');
const chatBackgroundFade = document.getElementById('chat-background-fade');
const messageListEl = document.getElementById('message-list');

const replyPreview = document.getElementById('reply-preview');
const replyPreviewText = document.getElementById('reply-preview-text');
const replyCancelBtn = document.getElementById('reply-cancel-btn');

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
  unsubscribeFromThread(currentChannel);
  currentChannel = null;
  unsubscribeFromThread(ownerInboxChannel);
  ownerInboxChannel = null;
  currentThreadFriendId = null;
  stopTitleFlash();
  await supabase.auth.signOut();
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
});

// ---------- Composer: reply + send + Enter-to-send ----------

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    composer.requestSubmit();
  }
});

textInput.addEventListener('input', () => {
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
});

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

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThreadFriendId) return;

  const text = textInput.value.trim();
  const file = imageInput.files[0];
  const replyTo = replyingTo?.id ?? null;

  try {
    if (file) {
      await sendImageMessage(currentThreadFriendId, currentUser.id, file, replyTo);
      imageInput.value = '';
    }
    if (text) {
      await sendTextMessage(currentThreadFriendId, currentUser.id, text, replyTo);
      textInput.value = '';
      textInput.style.height = 'auto';
    }
    clearReply();
  } catch (err) {
    alert('傳送失敗：' + err.message);
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

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) stopTitleFlash();
});

function notify(body) {
  if (document.hidden) startTitleFlash();
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    new Notification('chatweb', { body });
  }
}

// ---------- Online presence ----------

function updateOnlineUI() {
  if (currentIsOwner) {
    friendListEl.querySelectorAll('.friend-item').forEach((item) => {
      const dot = item.querySelector('.status-dot');
      if (dot) dot.classList.toggle('online', onlineIds.has(item.dataset.friendId));
    });
  } else {
    peerStatusDot.classList.toggle('online', onlineIds.has(OWNER_UUID));
  }
}

// ---------- App init ----------

async function initApp(user) {
  currentUser = user;
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
    await renderFriendList();
    ownerInboxChannel = subscribeToOwnerInbox(handleOwnerInboxInsert);
  } else {
    friendListEl.classList.add('hidden');
    peerStatusEl.classList.remove('hidden');
    peerStatusText.textContent = '對方';
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

  notify(`${friendDisplayNames.get(row.friend_id) ?? '朋友'}：${quoteSnippet(row)}`);

  const item = friendListEl.querySelector(`[data-friend-id="${row.friend_id}"]`);
  if (item) {
    const badge = item.querySelector('.unread-badge');
    const next = (parseInt(badge.textContent, 10) || 0) + 1;
    badge.textContent = String(next);
    badge.classList.remove('hidden');
  }
}

async function renderFriendList() {
  const { data, error } = await supabase.from('friends').select('*').order('display_name');
  friendListEl.innerHTML = '';

  if (error) {
    friendListEl.textContent = '朋友名單載入失敗';
    return;
  }

  const myReadStates = await getMyReadStates(OWNER_UUID);
  const lastReadByFriend = new Map(myReadStates.map((s) => [s.friend_id, s.last_read_at]));

  for (const friend of data) {
    friendDisplayNames.set(friend.id, friend.display_name);

    const item = document.createElement('div');
    item.className = 'friend-item';
    item.dataset.friendId = friend.id;

    const dot = document.createElement('span');
    dot.className = 'status-dot';
    item.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'friend-name';
    name.textContent = friend.display_name;
    item.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'unread-badge hidden';
    badge.textContent = '0';
    item.appendChild(badge);

    const unread = await getUnreadCount(friend.id, lastReadByFriend.get(friend.id) ?? null, OWNER_UUID);
    if (unread > 0) {
      badge.textContent = String(unread);
      badge.classList.remove('hidden');
    }

    item.addEventListener('click', () => {
      document.querySelectorAll('.friend-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
      badge.textContent = '0';
      badge.classList.add('hidden');
      openThread(friend.id, friend.background_image);
    });

    friendListEl.appendChild(item);
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

  markThreadRead(friendId, currentUser.id).catch(() => {});

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
        notify(quoteSnippet(row));
        markThreadRead(friendId, currentUser.id).catch(() => {});
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

// 進站時如果已經有登入 session 就直接進 app，不用重新輸入密碼
const { data: { session } } = await supabase.auth.getSession();
if (session) {
  await initApp(session.user);
}
