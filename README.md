# Kareocar

長照接送媒合與行程管理平台。

- 網站：[kareocar.netlify.app](https://kareocar.netlify.app/)
- GitHub：[viz963-1216/Kareocar](https://github.com/viz963-1216/Kareocar)

## 專案狀態

這個版本庫仍在逐步整理與開發。前端由 Netlify 發布，API 位於 `netlify/functions/`；資料庫遷移與 PostgreSQL 權限政策放在 `supabase/`。`apps-script/` 也仍有被 API 呼叫的路徑，屬於目前混合架構的一部分。刪除其中任一區前，先確認呼叫關係與正式環境切換狀況。

第一版需求已整理，但不代表功能都已完成。請先看[完成度核對](docs/specification/v1/IMPLEMENTATION_STATUS.md)，再看[開發與驗收清單](docs/specification/v1/DEVELOPMENT_ACCEPTANCE.md)。

## 從哪裡開始

| 你要找的內容 | 位置 |
| --- | --- |
| 產品需求 | [docs/specification/v1/PRODUCT_SPEC.md](docs/specification/v1/PRODUCT_SPEC.md) |
| 完成度與程式依據 | [docs/specification/v1/IMPLEMENTATION_STATUS.md](docs/specification/v1/IMPLEMENTATION_STATUS.md) |
| 開發順序與驗收情境 | [docs/specification/v1/DEVELOPMENT_ACCEPTANCE.md](docs/specification/v1/DEVELOPMENT_ACCEPTANCE.md) |
| 資料庫遷移與測試方式 | [supabase/README.md](supabase/README.md) |
| AI 協作與授權界線 | [CLAUDE.md](CLAUDE.md) |
| 舊版部署及安全紀錄 | [docs/archive/](docs/archive/)（歷史資料，不是目前部署指引） |

## 目錄導覽

| 路徑 | 用途 |
| --- | --- |
| `index.html` | 網站前端 |
| `netlify.toml`, `_headers` | Netlify 路由與安全標頭 |
| `netlify/functions/` | 網站 API 與外部服務入口 |
| `supabase/migrations/` | PostgreSQL schema、函式與權限政策；資料庫變更的版本來源 |
| `supabase/tests/` | PostgreSQL、交易與 RLS 測試 |
| `apps-script/` | 仍有呼叫路徑的 Apps Script 程式 |
| `tests/` | Node 離線回歸測試及 Apps Script 模擬環境 |
| `tools/` | 本機檢查與開發工具 |
| `docs/specification/v1/` | 第一版需求、完成度及驗收規格 |
| `docs/archive/` | 舊版操作與安全紀錄，供追溯 |
| `.github/workflows/` | GitHub Actions 隔離資料庫檢查 |

## 本機檢查

```bash
npm test
node tools/check-inline-js.js
node tools/check-dom-refs.js
node tools/check-id-mapping.js
```

完整 PostgreSQL／RLS 測試需使用**可丟棄的本機測試資料庫**，指令與注意事項見 [supabase/README.md](supabase/README.md)。測試腳本會刪除並重建指定的本機資料庫，絕不可將正式資料庫設為測試目標。

## 重要維護原則

- 前端、Netlify API、資料庫遷移彼此有契約；變更時核對相關層及測試。
- API 連資料庫必須使用受 RLS 限制的 `care_ride_app` 角色，不能使用資料庫擁有者 `postgres`。
- 金鑰、密碼、OAuth secret 及正式資料不得提交到 GitHub。
- 正式資料庫變更與正式部署依專案授權流程執行；文件中的歷史步驟不代表目前核准的操作程序。
