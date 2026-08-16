// 到 Supabase 後台 Settings -> API 複製這兩個值填進來
// anon public key 本身設計上就是可以公開的，權限是靠資料庫的 RLS 規則保護，不是靠隱藏這把 key
export const SUPABASE_URL = 'https://rbehmtjdowawqlsvyrlr.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_JS1oGdVX00wcpU59Y-phoQ_kVp8OmtA';

// 你自己（owner）帳號的 UUID，跟 supabase/schema.sql 裡填的 <OWNER_UUID> 要一致
export const OWNER_UUID = '1daffde3-7672-43ff-b34e-7552586b1f16';

// 朋友登入後，畫面上稱呼你的名字
export const OWNER_DISPLAY_NAME = 'YCLin';
