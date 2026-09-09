# V12.26.1 部署與遷移

這一版改了**資料存放位置**，不只是程式邏輯。部署順序有影響，請照下面走。

## 改了什麼

| 資料 | 原本 | 現在 | 原因 |
|---|---|---|---|
| 密碼憑證 | Script Properties | 新工作表「密碼憑證」 | 解除 500KB／約 885 人的硬上限；pepper 與雜湊改為分屬不同儲存體 |
| 登入失敗計數、IP 計數 | Script Properties | CacheService | 原本永久累積不會過期，會慢慢把額度吃光 |
| 密碼重設驗證碼與節流 | Script Properties | CacheService | 同上，且本來就只需活 5 分鐘 |
| Session 版本 | Script Properties | 不變 | 必須長期保存，但只有變更過密碼的帳號才會佔用 |

實測效果：1000 位使用者加 1000 筆登入失敗紀錄，Script Properties 的增量是 **0 bytes**（原本約 578 KB，已經超過上限）。

## 部署步驟

### 1. 先更新 Apps Script

把 `apps-script/` 下所有 `.gs` 貼進 Apps Script 專案，**建立新版本並更新 Web App 部署**。

新版第一次執行時會自動建立「密碼憑證」工作表（預設隱藏）。

### 2. 執行一次憑證遷移

在 Apps Script 編輯器執行：

```javascript
authMigrateCredentialsToSheet_()
```

回傳 `{moved, skipped, remainingKeys}`。`moved` 應該等於目前有密碼的帳號數。

這一步**不是必要的**——沒執行的話，每位使用者下次成功登入時會自動遷移。手動執行只是讓遷移一次做完，立刻把 Properties 的壓力釋放掉。無論走哪條路，**使用者都不需要重設密碼**。

確認目前用量：

```javascript
authPropertiesUsage_()
```

回傳 `percentUsed`。遷移後應該掉到個位數。

### 3. 更新 Netlify

前端與 Functions 一起部署。

### 4. 驗收

`GET /api/health` 應回報：

- `rowAuthorizationVersion: "12.26.1"`
- `authConfigured: true`
- `auditWriteFailures.count: 0`

實際登入一次，確認：

- 既有帳號用原密碼可以登入（憑證遷移正確）
- 連續打錯 5 次會被鎖，約 3 分鐘後自動解除（快取 TTL 正常）

## 需要注意的取捨

**速率狀態放在 CacheService 是有代價的。** CacheService 是盡力而為的儲存，快取項目可能在 TTL 到期前就被清掉，等同於失敗計數提早歸零，攻擊者因此可能拿到比 5 次更多的嘗試機會。

我仍然認為這個交換值得：真正的成本防線是迭代雜湊本身（每次嘗試都要花掉伺服器 200–500ms）與 IP 維度限制，而讓 Script Properties 被撐爆會導致**整個平台寫不進任何資料**，那嚴重得多。

如果之後要更嚴格，正確做法是把速率狀態也移到工作表並定期清理過期列，而不是搬回 Script Properties。

## 備份

「密碼憑證」工作表現在是還原帳號的必要資料。備份試算表時**務必包含這張隱藏工作表**（Google Sheet 的版本記錄與匯出都會涵蓋，但如果你是用腳本挑特定工作表匯出，記得把它加進去）。

雜湊本身經過 pepper 處理，pepper 留在 Script Properties——所以請**分開備份**這兩者，不要放在同一個地方，否則就失去了分離存放的意義。
