# chatweb

給少數朋友使用的一對一私人聊天網頁。每位朋友登入後只會看到自己與你（owner）的對話，看不到其他人聊天的內容。文字訊息存在資料庫、圖片存在雲端儲存空間、訊息 7 天後自動清除、支援即時更新。

- 前端：純 HTML/CSS/JS，部署在 GitHub Pages
- 後端：Supabase（資料庫 + 帳號登入 + 圖片儲存 + 即時通知）

---

## 一、Supabase 後台設定（第一次設定，跟著做一次就好）

### 1. 建立你自己的帳號
1. 進入你的 Supabase 專案 → 左側選單 **Authentication** → **Users** → **Add user**
2. 建立你自己的帳號（email + 密碼），建立時記得勾選 **Auto Confirm User**（不用寄驗證信）
3. 建立完成後，點進這個使用者，複製他的 **UUID**（一長串英數字），這個就是「你」在系統裡的身分識別碼

### 2. 執行資料庫腳本
1. 打開專案裡的 [`supabase/schema.sql`](supabase/schema.sql)
2. 用編輯器把裡面所有的 `<OWNER_UUID>` 取代成你剛剛複製的 UUID（保留前後的單引號）
3. 到 Supabase 後台左側選單 **SQL Editor** → **New query**
4. 貼上整份修改後的 SQL，點 **Run**

> 如果執行到 `pg_cron` 那段報錯，先去 **Database** → **Extensions**，搜尋 `pg_cron` 並啟用，再重新執行那一段 SQL 即可。

### 3. 建立圖片儲存空間
1. 左側選單 **Storage** → **New bucket**
2. Bucket 名稱輸入 `chat-images`，**不要**勾選 Public（保持 private）

### 4. 開啟即時功能
腳本裡已經包含 `alter publication supabase_realtime add table public.messages;`，執行過第 2 步就不用再另外設定。如果想確認，可以到 **Database** → **Replication**，確認 `messages` 有出現在 realtime 清單中。

### 5. 幫每位朋友建立帳號
對每一位朋友重複以下步驟：

1. **Authentication** → **Users** → **Add user**
2. Email 可以用朋友的真實信箱，也可以隨便編一個（例如 `xiaoming@chatweb.local`），反正只是拿來登入用，記得勾選 **Auto Confirm User**
3. 密碼自己設定好，再私下（當面、私訊等安全管道）告訴朋友帳號密碼
4. 複製這位朋友的 UUID
5. 回到 **SQL Editor**，執行：
   ```sql
   insert into public.friends (id, display_name) values ('貼上朋友的UUID', '朋友的暱稱');
   ```

之後要新增朋友，重複這 5 個步驟即可。

### 6. 取得金鑰，填進專案設定檔
1. 左側選單 **Settings** → **API**
2. 複製 **Project URL** 和 **anon public** key
3. 打開專案裡的 [`config.js`](config.js)，填入：
   ```js
   export const SUPABASE_URL = '你的 Project URL';
   export const SUPABASE_ANON_KEY = '你的 anon public key';
   export const OWNER_UUID = '你自己的 UUID';
   ```

> `anon public` key 設計上就是可以公開的（之後會出現在 GitHub 上），真正的權限控管是靠資料庫的 RLS 規則，不是靠隱藏這把 key。千萬不要把 **service_role key** 放進這個專案，那把才是機密。

---

## 二、本機測試（部署前先在自己電腦上確認能動）

在專案資料夾下開一個簡易伺服器（擇一）：

```bash
python -m http.server 8000
```

瀏覽器打開 `http://localhost:8000`，分別用「你自己的帳號」和「朋友的帳號」登入測試：
- 文字訊息能不能送出、即時顯示
- 圖片能不能上傳、顯示
- 用朋友帳號登入時，是否只看得到自己的對話串
- 如果有多位朋友，互相看不到彼此的對話

---

## 三、部署到 GitHub Pages

```bash
git init
git add .
git commit -m "init chatweb"
git branch -M main
git remote add origin https://github.com/<你的帳號>/chatweb.git
git push -u origin main
```

推上去之後：
1. 到 GitHub 上的 repo 頁面 → **Settings** → **Pages**
2. **Source** 選 `Deploy from a branch`，branch 選 `main`，資料夾選 `/ (root)`，儲存
3. 等一兩分鐘，GitHub 會給你一個網址（通常是 `https://<你的帳號>.github.io/chatweb/`）
4. 把這個網址加上帳號密碼分享給朋友，他們打開網址、輸入自己的帳號密碼就能進入聊天室

> repo 裡只有程式碼跟公開的 anon key，不會有任何聊天內容，所以設成 public repo 是安全的。
