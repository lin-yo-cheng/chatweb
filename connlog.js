// 連線狀態記錄：只存在這個瀏覽器的 localStorage，不會上傳，也不會顯示在畫面上。
// 用途是事後排查「訊息為什麼沒即時收到」——可以看到即時連線什麼時候斷、什麼時候重連，
// 以及定期檢查有沒有補抓到即時連線漏掉的訊息。
const KEY = 'chatweb-conn-log';
const MAX_ENTRIES = 150;

export function logConn(event, detail = '') {
  const entry = { t: new Date().toISOString(), event, detail: String(detail) };
  console.debug('[chatweb]', entry.event, entry.detail);
  try {
    const list = JSON.parse(localStorage.getItem(KEY)) || [];
    list.push(entry);
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    // localStorage 不可用或內容損壞時，記錄功能直接略過，不影響聊天
  }
}
