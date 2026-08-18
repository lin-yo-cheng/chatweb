-- ============================================================
-- chatweb 資料庫初始化腳本
--
-- 使用方式：
-- 1. 先在 Supabase 後台 Authentication -> Add user 建立「你自己」的帳號
-- 2. 複製你剛建立帳號的 UUID（在 Authentication -> Users 清單可以看到）
-- 3. 用編輯器把下面所有的 <OWNER_UUID> 取代成你的 UUID（注意保留單引號）
-- 4. 把整份檔案貼到 Supabase 後台 SQL Editor，執行一次即可
-- ============================================================

-- ------------------------------------------------------------
-- 1. 朋友名單表：owner 用來記錄「有哪些朋友帳號」
-- ------------------------------------------------------------
create table if not exists public.friends (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  background_image text,
  created_at timestamptz not null default now()
);

alter table public.friends enable row level security;

-- owner 能看整份朋友名單；每位朋友只能看到自己那一筆（用來讀取自己的背景圖設定）
create policy "owner can read friends list"
  on public.friends for select
  using (auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16');

create policy "friend can read own row"
  on public.friends for select
  using (auth.uid() = id);

create policy "owner can manage friends list"
  on public.friends for insert
  with check (auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16');

create policy "owner can update friends list"
  on public.friends for update
  using (auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16');

-- ------------------------------------------------------------
-- 2. 訊息表
-- ------------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  friend_id uuid not null references auth.users(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  content text,
  image_path text,
  created_at timestamptz not null default now(),
  constraint content_or_image check (content is not null or image_path is not null)
);

create index if not exists messages_friend_id_created_at_idx
  on public.messages (friend_id, created_at);

alter table public.messages
  add column if not exists reply_to uuid references public.messages(id) on delete set null;

alter table public.messages
  add column if not exists edited_at timestamptz;

alter table public.messages enable row level security;

-- 朋友只能看自己那條對話串；owner 能看所有對話串
create policy "read own thread or owner reads all"
  on public.messages for select
  using (
    auth.uid() = friend_id
    or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
  );

-- 朋友只能以自己身分、寫進自己的對話串；owner 能以自己身分寫進任一對話串
create policy "insert into own thread or owner insert anywhere"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and (
      (auth.uid() = friend_id)
      or (auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16')
    )
  );

-- 只有原發送者能編輯自己的訊息內容，owner 也不能改朋友說的話
create policy "sender can edit own message"
  on public.messages for update
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- 自己傳的訊息可以刪；owner 能刪任一則訊息
create policy "delete own message or owner deletes any"
  on public.messages for delete
  using (
    sender_id = auth.uid()
    or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
  );

-- ------------------------------------------------------------
-- 3. 加入 Realtime（即時訊息用）
--    刪除訊息要即時通知對方，需要 REPLICA IDENTITY FULL
--    否則 DELETE 事件裡不會帶 friend_id，前端的過濾條件會抓不到
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter table public.messages replica identity full;

-- ------------------------------------------------------------
-- 4. 7 天自動清除舊訊息
--    先到 Database -> Extensions 開啟 "pg_cron"，再執行下面這段
-- ------------------------------------------------------------
select cron.schedule(
  'delete-old-messages',
  '0 3 * * *',
  $$ delete from public.messages where created_at < now() - interval '7 days' $$
);

-- ------------------------------------------------------------
-- 5. Storage：建立 chat-images bucket 的存取政策
--    bucket 本身請先到 Storage 頁面手動建立，命名為 chat-images，設定為 Private
--    建立好 bucket 後，再執行下面這段建立政策
-- ------------------------------------------------------------
create policy "read own thread images or owner reads all"
  on storage.objects for select
  using (
    bucket_id = 'chat-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
    )
  );

create policy "upload into own thread folder or owner uploads anywhere"
  on storage.objects for insert
  with check (
    bucket_id = 'chat-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
    )
  );

create policy "delete own thread images or owner deletes any"
  on storage.objects for delete
  using (
    bucket_id = 'chat-images'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
    )
  );

-- ------------------------------------------------------------
-- 6. 已讀進度表：記錄每個人在每個對話串看到哪個時間點
--    未讀分隔線、朋友清單未讀徽章、已讀顯示都靠這張表
-- ------------------------------------------------------------
create table if not exists public.read_state (
  friend_id uuid not null references auth.users(id) on delete cascade,
  reader_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (friend_id, reader_id)
);

alter table public.read_state enable row level security;

-- 對話串的兩個人都能互相看到彼此的已讀進度（用來顯示「已讀」跟算未讀數）
create policy "thread participants read read_state"
  on public.read_state for select
  using (
    auth.uid() = friend_id
    or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16'
  );

-- 每個人只能寫自己的已讀進度，且只能寫自己有份的對話串
create policy "self writes own read_state"
  on public.read_state for insert
  with check (
    reader_id = auth.uid()
    and (friend_id = auth.uid() or auth.uid() = '1daffde3-7672-43ff-b34e-7552586b1f16')
  );

create policy "self updates own read_state"
  on public.read_state for update
  using (reader_id = auth.uid())
  with check (reader_id = auth.uid());

alter publication supabase_realtime add table public.read_state;
alter table public.read_state replica identity full;

-- ------------------------------------------------------------
-- 7. 新增朋友帳號後，記得手動執行這行（把值換成剛建立的朋友帳號）
--    example:
--    insert into public.friends (id, display_name) values ('友人的-uuid', '小明');
-- ------------------------------------------------------------
