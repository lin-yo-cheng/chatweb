import { supabase } from './supabaseClient.js';
import { OWNER_UUID } from './config.js';
import {
  loadMessages,
  sendTextMessage,
  sendImageMessage,
  subscribeToThread,
  unsubscribeFromThread,
  renderMessageNode,
} from './chat.js';

const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');

const friendListEl = document.getElementById('friend-list');
const chatPlaceholder = document.getElementById('chat-placeholder');
const messageListEl = document.getElementById('message-list');
const composer = document.getElementById('composer');
const textInput = document.getElementById('text-input');
const imageInput = document.getElementById('image-input');

let currentUser = null;
let currentIsOwner = false;
let currentThreadFriendId = null;
let currentChannel = null;

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
  currentThreadFriendId = null;
  await supabase.auth.signOut();
  appView.classList.add('hidden');
  loginView.classList.remove('hidden');
});

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThreadFriendId) return;

  const text = textInput.value.trim();
  const file = imageInput.files[0];

  try {
    if (file) {
      await sendImageMessage(currentThreadFriendId, currentUser.id, file);
      imageInput.value = '';
    }
    if (text) {
      await sendTextMessage(currentThreadFriendId, currentUser.id, text);
      textInput.value = '';
    }
  } catch (err) {
    alert('傳送失敗：' + err.message);
  }
});

async function initApp(user) {
  currentUser = user;
  loginView.classList.add('hidden');
  appView.classList.remove('hidden');

  currentIsOwner = user.id === OWNER_UUID;

  if (currentIsOwner) {
    friendListEl.classList.remove('hidden');
    await renderFriendList();
  } else {
    friendListEl.classList.add('hidden');
    const { data: myRow } = await supabase
      .from('friends')
      .select('*')
      .eq('id', user.id)
      .single();
    await openThread(user.id, myRow?.background_image);
  }
}

async function renderFriendList() {
  const { data, error } = await supabase.from('friends').select('*').order('display_name');
  friendListEl.innerHTML = '';

  if (error) {
    friendListEl.textContent = '朋友名單載入失敗';
    return;
  }

  for (const friend of data) {
    const item = document.createElement('div');
    item.className = 'friend-item';
    item.textContent = friend.display_name;
    item.addEventListener('click', () => {
      document.querySelectorAll('.friend-item').forEach((el) => el.classList.remove('active'));
      item.classList.add('active');
      openThread(friend.id, friend.background_image);
    });
    friendListEl.appendChild(item);
  }
}

async function openThread(friendId, backgroundImage) {
  if (currentChannel) {
    unsubscribeFromThread(currentChannel);
    currentChannel = null;
  }

  currentThreadFriendId = friendId;
  chatPlaceholder.classList.add('hidden');
  messageListEl.classList.remove('hidden');
  composer.classList.remove('hidden');
  messageListEl.innerHTML = '';

  if (backgroundImage) {
    messageListEl.style.backgroundImage =
      `linear-gradient(rgba(255,255,255,0.72), rgba(255,255,255,0.72)), url('${backgroundImage}')`;
  } else {
    messageListEl.style.backgroundImage = 'none';
  }

  const rows = await loadMessages(friendId);
  for (const row of rows) {
    const node = await renderMessageNode(row, currentUser.id, currentIsOwner);
    messageListEl.appendChild(node);
  }
  scrollToBottom();

  currentChannel = subscribeToThread(friendId, {
    onInsert: async (row) => {
      const node = await renderMessageNode(row, currentUser.id, currentIsOwner);
      messageListEl.appendChild(node);
      scrollToBottom();
    },
    onDelete: (row) => {
      const node = messageListEl.querySelector(`[data-message-id="${row.id}"]`);
      if (node) node.remove();
    },
  });
}

function scrollToBottom() {
  messageListEl.scrollTop = messageListEl.scrollHeight;
}

// 進站時如果已經有登入 session 就直接進 app，不用重新輸入密碼
const { data: { session } } = await supabase.auth.getSession();
if (session) {
  await initApp(session.user);
}
