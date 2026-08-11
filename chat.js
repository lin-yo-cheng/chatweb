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

export async function sendTextMessage(friendId, senderId, text) {
  const { error } = await supabase
    .from('messages')
    .insert({ friend_id: friendId, sender_id: senderId, content: text });

  if (error) throw error;
}

export async function sendImageMessage(friendId, senderId, file) {
  const path = `${friendId}/${Date.now()}_${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(path, file);
  if (uploadError) throw uploadError;

  const { error: insertError } = await supabase
    .from('messages')
    .insert({ friend_id: friendId, sender_id: senderId, image_path: path });
  if (insertError) throw insertError;
}

export async function downloadImageUrl(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  return URL.createObjectURL(data);
}

export async function deleteMessage(row) {
  if (row.image_path) {
    await supabase.storage.from(BUCKET).remove([row.image_path]);
  }
  const { error } = await supabase.from('messages').delete().eq('id', row.id);
  if (error) throw error;
}

export function subscribeToThread(friendId, { onInsert, onDelete }) {
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
    .subscribe();

  return channel;
}

export function unsubscribeFromThread(channel) {
  if (channel) supabase.removeChannel(channel);
}

export async function renderMessageNode(row, currentUserId, isOwner) {
  const rowEl = document.createElement('div');
  rowEl.className = 'msg-row' + (row.sender_id === currentUserId ? ' mine' : '');
  rowEl.dataset.messageId = row.id;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (row.content) {
    const p = document.createElement('div');
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
    bubble.appendChild(delBtn);
  }

  rowEl.appendChild(bubble);
  return rowEl;
}
