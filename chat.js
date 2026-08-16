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

export async function deleteMessage(row) {
  if (row.image_path) {
    await supabase.storage.from(BUCKET).remove([row.image_path]);
  }
  const { error } = await supabase.from('messages').delete().eq('id', row.id);
  if (error) throw error;
}

export function subscribeToThread(friendId, { onInsert, onDelete, onReadStateChange }) {
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
    .subscribe();

  return channel;
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

  if (row.content) {
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = row.content;
    bubble.appendChild(p);
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
  time.textContent = new Date(row.created_at).toLocaleString('zh-TW', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
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
