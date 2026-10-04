# 協作指引

這份文件規範 AI 代理人在本專案的分工、交付格式與授權邊界。

專案本身的技術規則不在這裡重複，見：

- [README.md](README.md) — 架構、測試指令、版本紀錄
- [supabase/README.md](supabase/README.md) — schema、RLS、本機測試環境
- [DEPLOYMENT.md](DEPLOYMENT.md) — 部署與正式上線檢查
- [SECURITY_HARDENING.md](SECURITY_HARDENING.md) — 資安模型
- [docs/RESTORE_RUNBOOK.md](docs/RESTORE_RUNBOOK.md) — 備份與還原

其中兩條最容易踩、且後果最嚴重的，在這裡再提一次：

- `DATABASE_URL` 必須用 `care_ride_app` 角色。用 `postgres` 會繞過全部 RLS
  政策，而且不會有任何錯誤訊息。
- `index.html`、`netlify/functions/`、`supabase/migrations/` 之間有契約相依：
  動到其中一層時，要確認另外兩層有沒有跟著改的必要，**有相依才一起改**。
  例如改了 API 的請求／回應形狀，前端與 function 要同步；改了資料表欄位或
  RLS，function 與 migration 要同步。純前端樣式、純測試、純文件的改動不需要
  為了「三件一起」去動無關的檔案。

---

## 分工

| 角色 | 職責 |
|---|---|
| Claude | 主要開發、相關測試與修正 |
| Codex | 重要改動的技術審查、明確交辦的疑難問題 |
| Gemini | 需求情境整理與使用者流程驗收 |
| repo owner | 決定需求、優先順序與最後驗收 |

每項任務只指定一位程式碼修改負責人。需要換手時先交接目前狀態。

## 版本基準

- 以 GitHub 指定分支為準。
- 每次任務記錄基準 commit，交付與審查記錄 PR 最新 commit。
- **審查結果只適用於已檢查的那個版本。** 之後的 commit 需重新確認。

## 閱讀範圍

從任務相關檔案與變更開始讀，必要時才擴大範圍。

---

## 交付格式

### 詳細內容放 PR

修改說明、測試證據、分析推導、風險評估——全部寫在 PR 描述或 commit message
裡，不在聊天重貼。PR 是可追溯、可審查、可回頭查的載體；聊天不是。

PR 描述應涵蓋以下交接資訊：

1. 任務目標與驗收條件
2. 負責人、分支、基準 commit 與最新 commit
3. 修改摘要
4. 已執行的測試及結果
5. 未解問題與需要下一位檢查的範圍

### 聊天交付固定六項

總長盡量不超過 300 字：

1. **PR 連結** — 單獨放完整網址，不把說明文字塞進連結
2. **最新 commit**
3. **本次完成事項**
4. **測試** — 通過／失敗／未執行
5. **需要使用者決定的事項** — 沒有就寫「無」
6. **下一步與負責人**

---

## 證據分級

回報時必須明確區分三種確信程度，不可混用：

| 層級 | 意思 | 可以怎麼說 |
|---|---|---|
| 程式碼靜態推導 | 讀版本庫的程式碼推論出來的 | 「版本庫內未找到相關機制」 |
| 實際測試 | 真的跑過，有輸出 | 「已執行 X，結果 Y」 |
| 正式環境已確認 | 在正式環境實際查驗過設定 | 「已在正式環境確認 Z」 |

**靜態推導不能寫成絕對結論。** 版本庫裡沒有，不等於正式環境沒有——正式
Supabase 可能有版本庫外的 trigger、webhook、排程或外部訂閱；Netlify 可能有
版本庫外的環境變數或建置設定。這些未經核實就不能宣稱「不可能發生」。

測試未執行就寫「未執行」，不要用推導冒充驗證。但在寫「未執行」之前，先確認
隔離 CI 是不是跑得到（見下方「SQL 與 RLS 怎麼驗證」）——跑得到卻沒跑，不算
「無法驗證」。

## 審查與驗收

- 審查請提供具體證據、觸發條件與影響。
- 驗收請區分實際操作與情境推演。
- 低風險小修改由負責人自行驗證；重要改動才安排額外審查。
- 修正後聚焦受影響部分複查。

---

## 授權邊界

- **已獲授權的範圍不要重複詢問。** 授權過就做完，不要每一步回頭確認。
- 以下三類即使在任務脈絡中出現，仍須另行說明並取得同意：
  - 正式資料庫寫入
  - 部署
  - 安裝軟體
- 授權是逐項、逐次的。某一輪的同意不自動延伸到下一輪或相似操作。

## 資料庫環境

兩個 Supabase 專案，見 [README.md](README.md) 的「環境」：

- **Production**：Netlify 的 Production context。migration 只在人工觸發時套用。
- **Staging**：Netlify 的 Deploy Previews 與 Branch deploys。合併到 main 後自動套用 migration。
- 建置檢查（`tools/check-db-config.js`）會擋下「非 production 的建置連到正式資料庫」；
  migration workflow 套用前會確認連線字串指向預期的專案（`describe-db-url.py --expect-ref`）。
  `DATABASE_URL` 本身是 Secret、讀不回來，所以隔離靠的是這兩道檢查，不是肉眼比對。

規則：

- 不拿正式庫試跑未驗證的 SQL；寫入驗收在 Staging 或拋棄式資料庫做。
- 正式庫的寫入一律另行取得同意，見上面的授權邊界。

## SQL 與 RLS 怎麼驗證

有隔離 CI 可以用，**不要再用「本機沒有 Postgres 所以只能標示未執行」當結論**：

- `.github/workflows/isolated-sql-review.yml` 會在用完即丟的 `postgres:16`
  容器上，用 `supabase/migrations/` 的實際 migration 建庫，跑 seed 情境、各項
  整合測試（RLS、業務流程、登入、補助、隱私、備份還原等）、連線設定解析，
  Node 20 與 24 各一輪。觸發條件是
  `supabase/**`、`netlify/functions/**`、`tests/**`、`package.json` 與該
  workflow 本身的變動，也可以手動 `workflow_dispatch`。
- 本機若有 Postgres 16，可用 [supabase/README.md](supabase/README.md#本機測試)
  的步驟或 `supabase/tests/run-all.sh`。
- `tests/run.sh` 是純 Node 的離線套件，不需要資料庫。

所以 SQL/RLS 改動的預設做法是**推上分支開 PR 讓隔離 CI 跑**，拿到實際執行
證據。只有在 CI 也涵蓋不到的情況才標示「未執行」，並寫清楚是哪一部分涵蓋
不到。

---

## Agent skills

### Issue tracker

Issue 與 spec 記在 GitHub Issues（viz963-1216/Kareocar），用 `gh` CLI 操作。見 `docs/agents/issue-tracker.md`。

### Triage labels

使用預設的五個標籤：needs-triage、needs-info、ready-for-agent、ready-for-human、wontfix。見 `docs/agents/triage-labels.md`。

### Domain docs

單一 context：根目錄一份 `CONTEXT.md`，ADR 放在 `docs/adr/`。見 `docs/agents/domain.md`。
