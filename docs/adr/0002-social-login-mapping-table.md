# 社群登入用自己的對應表，不用 Supabase 的身分連結

需求者用 Google／Facebook 登入後要綁定手機帳號。Supabase 內建的身分連結（identity linking）做法是：先刪掉社群登入自動建立的帳號，再由既有帳號重新到 Google／Facebook 授權一次，使用者要確認兩次，長者很容易卡住。我們改成自己記一張對應表 `social_logins`（社群帳號 → 系統使用者），再由 Supabase 的 Custom Access Token Hook 把系統使用者 ID 放進 token，綁定只需要確認一次。代價是多了一張表與一個 Hook：Hook 必須在每個 Supabase 專案的 Authentication → Hooks 啟用，解除綁定與刪除帳號時也要一併清掉對應。

## Consequences

- 伺服器從 token 的 `app_user_id` 取使用者，沒有才用 `sub`；每次請求會檢查對應是否還在，解除綁定後舊 token 立即失效
- 不要改回 Supabase 的身分連結：那會讓綁定又變回兩次確認
