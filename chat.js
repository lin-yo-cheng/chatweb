import { supabase } from './supabaseClient.js';

const BUCKET = 'chat-images';

export async function loadMessages(friendId) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('friend_id', friendId)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data;
}

export async function sendTextMessage(friendId, senderId, text, replyTo) {
  const { error } = await supabase
    .from('messages')
    .insert({ friend_id: friendId, sender_id: senderId, content: text, reply_to: replyTo ?? null });

  if (error) throw error;
}

export async function sendImageMessage(friendId, senderId, file, replyTo) {
  const path = `${friendId}/${Date.now()}_${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file);
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase
    .from('messages')
    .insert({ friend_id: friendId, sender_id: senderId, image_path: path, reply_to: replyTo ?? null });
  if (insertError) throw insertError;
}

export async function downloadImageUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return URL.createObjectURL(data);
}

export async function markThreadRead(friendId, readerId) {
  const { error } = await supabase
    .from('read_state')
    .upsert(
      { friend_id: friendId, reader_id: readerId, last_read_at: new Date().toISOString() },
      { onConflict: 'friend_id,reader_id' }
    );
  if (error) throw error;
}

export async function getReadStates(friendId) {
  const { data, error } = await supabase
    .from('read_state')
    .select('*')
    .eq('friend_id', friendId);
  if (error) throw error;
  return data;
}

export async function getMyReadStates(readerId) {
  const { data, error } = await supabase
    .from('read_state')
    .select('*')
    .eq('reader_id', readerId);
  if (error) throw error;
  return data;
}

export async function getUnreadCount(friendId, sinceIso, excludeSenderId) {
  let query = supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('friend_id', friendId)
    .neq('sender_id', excludeSenderId);

  if (sinceIso) {
    query = query.gt('created_at', sinceIso);
  }

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function editMessage(row, newContent) {
  const { error } = await supabase
    .from('messages')
    .update({ content: newContent, edited_at: new Date().toISOString() })
    .eq('id', row.id);
  if (error) throw error;
}

export async function deleteMessage(row) {
  if (row.image_path) {
    await supabase.storage.from(BUCKET).remove([row.image_path]);
  }
  const { error } = await supabase.from('messages').delete().eq('id', row.id);
  if (error) throw error;
}

export function subscribeToThread(friendId, { onInsert, onDelete, onUpdate, onReadStateChange, onTyping }) {
  const channel = supabase
    .channel(`messages-${friendId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `friend_id=eq.${friendId}`,
      },
      (payload) => onInsert(payload.new)
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `friend_id=eq.${friendId}`,
      },
      (payload) => onUpdate?.(payload.new)
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `friend_id=eq.${friendId}`,
      },
      (payload) => onDelete(payload.old)
    )
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'read_state',
        filter: `friend_id=eq.${friendId}`,
      },
      (payload) => onReadStateChange?.(payload.new)
    )
    .on('broadcast', { event: 'typing' }, (payload) => onTyping?.(payload.payload.senderId))
    .subscribe();

  return channel;
}

export function broadcastTyping(channel, senderId) {
  if (!channel) return;
  channel.send({ type: 'broadcast', event: 'typing', payload: { senderId } });
}

export function subscribeToOwnerInbox(onInsert) {
  const channel = supabase
    .channel('owner-inbox')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages' },
      (payload) => onInsert(payload.new)
    )
    .subscribe();

  return channel;
}

export function unsubscribeFromThread(channel) {
  if (channel) supabase.removeChannel(channel);
}

export function quoteSnippet(row) {
  if (!row) return '';
  if (row.content) return row.content;
  if (row.image_path) return '📷 圖片';
  return '';
}

function formatMessageTime(row) {
  const base = new Date(row.created_at).toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return row.edited_at ? `${base}（已編輯）` : base;
}

function autoGrowTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function startEditing(textEl, timeEl, row) {
  const original = row.content;
  const textarea = document.createElement('textarea');
  textarea.className = 'edit-textarea';
  textarea.value = original;
  textEl.replaceWith(textarea);
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  autoGrowTextarea(textarea);
  textarea.addEventListener('input', () => autoGrowTextarea(textarea));

  let done = false;

  async function finish(save) {
    if (done) return;
    done = true;

    const newValue = textarea.value.trim();
    if (save && newValue && newValue !== original) {
      try {
        await editMessage(row, newValue);
        row.content = newValue;
        row.edited_at = new Date().toISOString();
        timeEl.textContent = formatMessageTime(row);
      } catch (err) {
        alert('編輯失敗：' + err.message);
      }
    }

    const restored = document.createElement('div');
    restored.className = 'msg-text';
    restored.textContent = row.content;
    textarea.replaceWith(restored);
  }

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
  textarea.addEventListener('blur', () => finish(true));
}

export async function renderMessageNode(row, currentUserId, isOwner, { repliedRow, onReply } = {}) {
  const rowEl = document.createElement('div');
  rowEl.className = 'msg-row' + (row.sender_id === currentUserId ? ' mine' : '');
  rowEl.dataset.messageId = row.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (row.reply_to) {
    const quote = document.createElement('div');
    quote.className = 'quote-block';
    quote.textContent = repliedRow ? quoteSnippet(repliedRow) : '原訊息已刪除';
    quote.addEventListener('click', () => {
      const target = document.querySelector(`[data-message-id="${row.reply_to}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    bubble.appendChild(quote);
  }

  let textEl = null;
  if (row.content) {
    textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = row.content;
    bubble.appendChild(textEl);
  }

  if (row.image_path) {
    const img = document.createElement('img');
    img.alt = '圖片';
    bubble.appendChild(img);
    downloadImageUrl(row.image_path)
      .then((url) => {
        img.src = url;
      })
      .catch(() => {
        img.alt = '圖片載入失敗';
      });
  }

  const time = document.createElement('time');
  time.textContent = formatMessageTime(row);
  bubble.appendChild(time);

  const toolbar = document.createElement('div');
  toolbar.className = 'msg-toolbar';

  const replyBtn = document.createElement('button');
  replyBtn.className = 'reply-btn';
  replyBtn.type = 'button';
  replyBtn.title = '回覆';
  replyBtn.textContent = '↩';
  replyBtn.addEventListener('click', () => onReply?.(row));
  toolbar.appendChild(replyBtn);

  if (textEl && row.sender_id === currentUserId) {
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-btn';
    editBtn.type = 'button';
    editBtn.title = '編輯';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', () => startEditing(textEl, time, row));
    toolbar.appendChild(editBtn);
  }

  if (row.sender_id === currentUserId || isOwner) {
    const delBtn = document.createElement('button');
    delBtn.className = 'delete-btn';
    delBtn.type = 'button';
    delBtn.title = '刪除訊息';
    delBtn.textContent = '×';
    delBtn.addEventListener('click', async () => {
      if (!confirm('確定要刪除這則訊息嗎？')) return;
      try {
        await deleteMessage(row);
      } catch (err) {
        alert('刪除失敗：' + err.message);
      }
    });
    toolbar.appendChild(delBtn);
  }

  bubble.appendChild(toolbar);

  if (row.sender_id === currentUserId) {
    const receipt = document.createElement('div');
    receipt.className = 'read-receipt';
    bubble.appendChild(receipt);
  }

  rowEl.appendChild(bubble);
  return rowEl;
}
