// 圖片清理
//
// 訊息被 7 天自動清除時，資料庫只會刪掉訊息資料列（裡面只有圖片的「路徑」），
// 儲存空間裡的圖片檔案不會跟著刪。這裡由 owner 登入時比對：
//   儲存空間裡的檔案  vs  還有訊息在用的圖片路徑
// 把「沒有任何訊息在用、而且上傳超過 1 天」的圖片刪掉。
//
// 刪檔案無法復原，所以有幾道保險：
// - 查詢「哪些圖片還在用」失敗、或結果可能被截斷時，整個中止
// - 上傳不滿 1 天的不刪（避免刪到剛上傳、訊息還沒寫進去的圖片）
// - 每次最多刪 MAX_DELETE_PER_RUN 個
// - 刪除沒有真的成功（例如缺少權限）時會報錯，不會假裝成功

const BUCKET = 'chat-images';
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DELETE_PER_RUN = 200;
const LIST_PAGE_SIZE = 1000;
const MESSAGE_QUERY_LIMIT = 1000; // 伺服器單次回傳上限，達到代表結果可能被截斷
const REMOVE_BATCH_SIZE = 100;

async function listFolder(client, folder) {
  const entries = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const { data, error } = await client.storage
      .from(BUCKET)
      .list(folder, { limit: LIST_PAGE_SIZE, offset });
    if (error) throw error;
    entries.push(...data);
    if (data.length < LIST_PAGE_SIZE) break;
  }
  return entries;
}

// 儲存空間裡每個檔案的完整路徑（朋友ID/檔名）。資料夾在清單裡 id 為 null。
async function listAllFiles(client) {
  const files = [];
  for (const entry of await listFolder(client, '')) {
    if (entry.id !== null) {
      files.push({ path: entry.name, created_at: entry.created_at, size: entry.metadata?.size ?? 0 });
      continue;
    }
    for (const file of await listFolder(client, entry.name)) {
      if (file.id === null) continue;
      files.push({
        path: `${entry.name}/${file.name}`,
        created_at: file.created_at,
        size: file.metadata?.size ?? 0,
      });
    }
  }
  return files;
}

export function selectOrphans(files, referencedPaths, now = Date.now()) {
  return files.filter((file) => {
    if (referencedPaths.has(file.path)) return false;

    // 上傳時間不明（沒有值或格式錯誤）就不刪，這是刻意的保守作法。
    // 注意 new Date(null) 會變成 1970 年，所以要先擋掉沒有值的情況
    if (!file.created_at) return false;
    const uploadedAt = new Date(file.created_at).getTime();
    if (Number.isNaN(uploadedAt)) return false;

    return now - uploadedAt >= MIN_AGE_MS;
  });
}

export async function cleanupOrphanImages(client, { dryRun = false, now = Date.now() } = {}) {
  const { data: refs, error: refError } = await client
    .from('messages')
    .select('image_path')
    .not('image_path', 'is', null)
    .limit(MESSAGE_QUERY_LIMIT);
  if (refError) throw refError;
  if (refs.length >= MESSAGE_QUERY_LIMIT) {
    throw new Error('有圖片的訊息數量超過查詢上限，為避免誤刪使用中的圖片，這次不清理');
  }
  const referenced = new Set(refs.map((row) => row.image_path));

  const files = await listAllFiles(client);
  const orphans = selectOrphans(files, referenced, now).slice(0, MAX_DELETE_PER_RUN);

  const result = {
    totalFiles: files.length,
    inUse: referenced.size,
    orphans: orphans.length,
    deleted: 0,
    dryRun,
  };
  if (dryRun || orphans.length === 0) return result;

  for (let i = 0; i < orphans.length; i += REMOVE_BATCH_SIZE) {
    const batch = orphans.slice(i, i + REMOVE_BATCH_SIZE).map((file) => file.path);
    const { data, error } = await client.storage.from(BUCKET).remove(batch);
    if (error) throw error;

    // 缺少刪除權限時，儲存 API 不會報錯，只是回傳空陣列，所以要自己核對數量
    const removed = data?.length ?? 0;
    result.deleted += removed;
    if (removed < batch.length) {
      throw new Error(
        `要刪除 ${batch.length} 個圖片，實際只刪除 ${removed} 個（累計已刪 ${result.deleted}），` +
          '可能是缺少儲存空間的刪除權限'
      );
    }
  }
  return result;
}
