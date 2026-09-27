// Supabase の接続先(ブラウザから見える前提の値だけを書く)
//
// Supabase ダッシュボード → Project Settings → API Keys
//   SUPABASE_URL             : Project URL(https://xxxx.supabase.co)
//   SUPABASE_PUBLISHABLE_KEY : Publishable key(sb_publishable_ で始まるもの)
//
// ※ secret キー / service_role キーは絶対に書かないこと。
//    書いてしまっても、assets/api.js が検知して動かないようにしてある。
export const SUPABASE_URL = 'https://ktmzzxdtvomsaxevfnjg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_INWqwAFU3XiRI8v21OiCOQ_NG_AcfZ7';
