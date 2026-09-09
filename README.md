# 安心接送

這是版本 `12.25.63` 的商用準備展示版。Netlify 提供前端、GitHub 保存私有原始碼，Google Sheets／Drive 保存受控資料結構。

## 專案連結

- 展示網站：https://care-ride-commercial-readiness.netlify.app
- 私有原始碼：https://github.com/viz963-1216/care-ride-commercial-readiness
- 私有資料結構：https://docs.google.com/spreadsheets/d/1sMu_yIuGiJzyq18Iiy4F55En8C1TtfHce-8L9Py1qkI/edit

## 版本與迭代

- 目前介面版本：`12.25.63`
- 累計部署迭代：第 `2` 次
- 第 1 次：建立 Google Sheets 資料結構、安全標頭、停用搜尋索引，完成 GitHub 與 Netlify 部署。
- 第 2 次：停用原始 Demo 資料自動生成、加入超級管理者自助更新與 Demo 資料清理功能、建立 Google Drive 合成測試資料。

## 目前可做什麼

- 展示登入、預約、派車、行程、車隊與稽核介面。
- 每位訪客的資料只存在各自瀏覽器；不會形成多人共用的正式資料庫。
- 已加入展示版警語、安全回應標頭與搜尋引擎暫停索引。

## 正式商用前必須完成

1. 使用 Firebase Auth 或等級相當的身分服務，移除瀏覽器內的明文密碼與測試 OTP。
2. 建立受控 HTTPS 後端，由後端驗證 token、套用 RBAC，再讀寫 Google Sheets／Drive。
3. 禁止瀏覽器直接存取公開試算表；服務證明照片須放在受限 Drive 資料夾並設定保存期限。
4. 完成個資告知、服務條款、資料保存／刪除流程、備份、日誌與資安測試。
5. 將示範帳號與預設密碼移出正式版本。

Google Antigravity 可作為後續開發與除錯工具，但不承擔正式網站託管、身分驗證或資料庫安全。
