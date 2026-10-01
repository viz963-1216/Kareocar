#!/usr/bin/env python3
"""
印出 MIGRATION_DATABASE_URL 的結構，方便排查連線失敗——不印密碼本身。

只輸出：使用者名稱、主機、port、資料庫、查詢參數、密碼是否存在與長度、
密碼裡是否還留著 [YOUR-PASSWORD] 佔位字串、是否含百分比編碼。
"""
import os
import sys
from urllib.parse import urlsplit, unquote

raw = os.environ.get('MIGRATION_DATABASE_URL', '').strip()
if not raw:
    print('沒有設定 MIGRATION_DATABASE_URL')
    sys.exit(1)
u = urlsplit(raw)
password = u.password or ''
print(f'scheme   : {u.scheme}')
print(f'user     : {unquote(u.username or "")}')
print(f'host     : {u.hostname}')
print(f'port     : {u.port}')
print(f'database : {u.path.lstrip("/")}')
print(f'query    : {u.query}')
print(f'password : {"有" if password else "沒有"}，解碼後 {len(unquote(password))} 個字元')
print(f'仍是佔位字串 [YOUR-PASSWORD]：{"是" if "YOUR-PASSWORD" in unquote(password) else "否"}')
print(f'含百分比編碼：{"是" if "%" in password else "否"}')
print(f'前後有空白：{"是" if unquote(password) != unquote(password).strip() else "否"}')
