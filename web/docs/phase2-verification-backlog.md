# Phase 2 — 延後驗證清單

**這份文件存在的理由**:某一輪裡「記為未驗證」的項目,如果只寫在當時的回報裡,
會在輪次交替時蒸發 —— 下一輪沒有人記得它還欠著,而它看起來像已經做完了。
**所有「本輪無法驗證」的項目一律登記在此,直到它被驗證或被明文放棄。**

規則:
1. 每一項都要有**為什麼這一輪驗不了**、**要誰做什麼才驗得了**、**排在哪一輪**
2. 驗證完成後**不刪除**,改標 ✅ 並附驗證日期與證據 —— 刪掉就失去「曾經欠過」的紀錄
3. 「已驗證」不可只憑「應該沒問題」;要有實跑結果

---

## 待驗

### ⏳ Google OAuth 端到端(排:輪 4 線上驗證)

**輪 1 驗到的**:點擊按鈕會呼叫 `signInWithOAuth({ provider: "google" })`,
且回傳 error 時畫面會顯示訊息。

**輪 1 沒驗到的**:**沒有真的走完一次 Google 登入。**
本機 Supabase 堆疊未啟用 Google provider,而啟用需要:

| 誰 | 做什麼 |
|---|---|
| user | 在 Google Cloud 建立 OAuth 2.0 用戶端(取得 client id / secret) |
| user | 在 Supabase 主控台 → Authentication → Providers 啟用 Google 並填入 |
| user | 在主控台的 Redirect URLs 加入 `https://my-twstock.vercel.app/auth/callback` |
| 我 | 線上實跑一次:點 Google → 完成授權 → 回跳 → `/trades` 顯示帳號 |

⚠️ 我**不能代為建立帳號或輸入憑證**,這幾步必須由 user 執行。

### ⏳ 正式站 redirect 允許清單(排:輪 4)

本機的允許清單寫在 `supabase/config.toml`(已加 `localhost:4330/auth/callback`),
**正式站的清單在 Supabase 主控台**,不在這個 repo 裡 —— 兩者不會自動同步。
未加入時的症狀:magic link 的 `redirect_to` 會被退回 `site_url`,
使用者點了信卻回到錯的頁面。**輪 1 就是這樣才發現的。**

### ⏳ Vercel 環境變數(排:輪 3 上線前)

`PUBLIC_SUPABASE_URL`、`PUBLIC_SUPABASE_ANON_KEY`(兩者皆為公開值)。
未設定時 `/trades` 會顯示「登入尚未開通」並維持唯讀預覽(fail closed,輪 1 已實測)。
🔴 `service_role` key **不放這裡、不放 repo、不放任何伺服器路由**。

### ⏳ 線上跨帳號隔離複驗(排:輪 4)

本機 42 項已全過,但**測試環境成功推論不到正式環境**(pg 版本、既有 schema、角色權限都可能不同)。
線上版需要兩個真實帳號,**由 user 執行**;我提供獨立自測頁(需明確參數才啟動、
只吃一個已知的 `user_id`、無連結入口)。

---

## 已驗證

*(尚無)*
