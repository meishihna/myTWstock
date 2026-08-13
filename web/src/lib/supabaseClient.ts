/**
 * Supabase client(瀏覽器端單例)
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 🔴 只用 anon key,而且【只在瀏覽器】。`service_role` 絕不進本 repo、
 *    不進 Vercel 環境變數、不進任何伺服器路由。
 *
 *    理由不是「怕外洩」,是【RLS 是產品保證,不是後端細節】:
 *    service_role 會繞過 RLS,保證就退化成「後端記得加 user_id 條件」。
 *    用 anon key + 使用者 JWT 時,過濾發生在資料庫,前端寫錯查詢最壞是
 *    「讀不到自己的」,不可能「讀到別人的」。
 *
 * 🔴 anon key 是設計上公開的值(它本身不授予任何資料存取權,
 *    所有權限來自 RLS + 使用者 JWT)。放在 PUBLIC_ 前綴的環境變數是正確用法。
 * ══════════════════════════════════════════════════════════════════════════
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = import.meta.env.PUBLIC_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.PUBLIC_SUPABASE_ANON_KEY as string | undefined;

/**
 * 設定是否齊全。**缺設定時一律 fail closed** ——
 * 不要退化成「假裝沒登入」或「靜默不查詢」,那會讓設定錯誤看起來像功能正常。
 */
export const supabaseConfigured = Boolean(URL && ANON);

/** 設定缺失時的說明(給畫面用,不是給 console 用) */
export const supabaseConfigError = supabaseConfigured
  ? null
  : `尚未設定 Supabase 連線(缺 ${[!URL && "PUBLIC_SUPABASE_URL", !ANON && "PUBLIC_SUPABASE_ANON_KEY"]
      .filter(Boolean)
      .join(" 與 ")})`;

let client: SupabaseClient | null = null;

/**
 * 取得單例。未設定時回 null —— 呼叫端必須處理,不可假設非空。
 *
 * `detectSessionInUrl: false`:回跳一律由 /auth/callback 明確處理,
 * 不讓任何頁面都去解析網址片段(多一條隱性路徑就多一種難查的行為)。
 */
export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured) return null;
  if (client) return client;
  client = createClient(URL!, ANON!, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: "tw-auth",
    },
  });
  return client;
}

/** 目前登入的使用者(未登入或未設定時回 null) */
export async function currentUser() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data } = await sb.auth.getUser();
  return data.user ?? null;
}
