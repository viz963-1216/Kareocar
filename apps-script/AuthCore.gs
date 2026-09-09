/**
 * AuthCore.gs — V12.26.0 (production hardening)
 *
 * Server-side password hashing + signed short-lived session tokens.
 * Secrets live only in Apps Script Properties.
 *
 * Changes vs 12.25.79:
 *  - Password hashing upgraded from a single HMAC-SHA256 to PBKDF2-HMAC-SHA256
 *    with a configurable iteration count. Legacy (v1) credentials are verified
 *    and transparently re-hashed to v2 on the next successful login.
 *  - All random values (salts, nonces, reset codes) now derive from
 *    Utilities.getUuid() (SecureRandom-backed) through SHA-256, instead of
 *    Math.random().
 *  - Login lockout is now an escalating *soft* lock with an expiry and an
 *    additional source-IP dimension. The old permanent `resetRequired` state
 *    let anyone disable another user's account by guessing wrong 10 times.
 *  - Password-reset requests are rate limited per phone number.
 */

var AUTH_CREDENTIAL_PREFIX_ = "AUTH_CRED_";
var AUTH_SESSION_VERSION_PREFIX_ = "AUTH_SESSION_VERSION_";
var AUTH_LOGIN_RATE_PREFIX_ = "AUTH_LOGIN_RATE_";
var AUTH_LOGIN_IP_RATE_PREFIX_ = "AUTH_LOGIN_IP_";
var AUTH_RESET_CHALLENGE_PREFIX_ = "AUTH_RESET_CHALLENGE_";
var AUTH_RESET_RATE_PREFIX_ = "AUTH_RESET_RATE_";

var AUTH_SESSION_TTL_SECONDS_ = 12 * 60 * 60;

/* Login throttling (per phone). Escalating soft lock — never permanent. */
var AUTH_LOGIN_WINDOW_SECONDS_ = 30 * 60;
var AUTH_LOGIN_LOCK_STEPS_ = Object.freeze([
  { failures: 5,  lockSeconds: 3 * 60 },
  { failures: 10, lockSeconds: 30 * 60 },
  { failures: 20, lockSeconds: 60 * 60 }
]);
var AUTH_LOGIN_MAX_LOCK_SECONDS_ = 60 * 60;

/* Login throttling (per source IP). Stops credential spraying across accounts. */
var AUTH_LOGIN_IP_WINDOW_SECONDS_ = 30 * 60;
var AUTH_LOGIN_IP_MAX_FAILURES_ = 30;
var AUTH_LOGIN_IP_LOCK_SECONDS_ = 30 * 60;

/* Password reset. */
var AUTH_RESET_TTL_SECONDS_ = 5 * 60;
var AUTH_RESET_MAX_ATTEMPTS_ = 3;
var AUTH_RESET_MIN_INTERVAL_SECONDS_ = 60;
var AUTH_RESET_WINDOW_SECONDS_ = 60 * 60;
var AUTH_RESET_MAX_PER_WINDOW_ = 5;

/* PBKDF2 cost. Tune with authBenchmarkPbkdf2_() and store the chosen value in
 * the AUTH_PBKDF2_ITERATIONS script property. Each credential records the
 * iteration count it was created with, so raising this never breaks logins. */
var AUTH_PBKDF2_DEFAULT_ITERATIONS_ = 6000;
var AUTH_PBKDF2_MIN_ITERATIONS_ = 1000;
var AUTH_PBKDF2_MAX_ITERATIONS_ = 100000;

function authError_(code, message) {
  var e = new Error(String(message || "驗證失敗"));
  e.code = String(code || "AUTH_ERROR");
  return e;
}

function authConfig_(name) {
  var value = "";
  if (typeof requireConfig_ === "function") {
    try { value = String(requireConfig_(name) || "").trim(); } catch (_) { value = ""; }
  }
  if (!value) value = String(PropertiesService.getScriptProperties().getProperty(name) || "").trim();
  if (!value) throw authError_("CONFIG_MISSING", "Apps Script 尚未設定 " + name);
  return value;
}

function authOptionalConfig_(name, fallback) {
  var value = String(PropertiesService.getScriptProperties().getProperty(name) || "").trim();
  return value || fallback;
}

/* ---------------------------------------------------------------- randomness */

function authBytesHex_(bytes) {
  return bytes.map(function (b) {
    var n = (b < 0 ? b + 256 : b);
    return ("0" + n.toString(16)).slice(-2);
  }).join("");
}

/**
 * Cryptographically secure hex string.
 * Utilities.getUuid() is backed by java.util.UUID.randomUUID() (SecureRandom);
 * hashing two of them removes the fixed version/variant nibbles so every
 * returned hex character carries full entropy.
 */
function authRandomHex_(bytes) {
  var want = Math.max(16, Number(bytes || 16));
  var out = "";
  while (out.length < want * 2) {
    var seed = Utilities.getUuid() + Utilities.getUuid() + String(out.length);
    out += authBytesHex_(Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, seed, Utilities.Charset.UTF_8));
  }
  return out.substring(0, want * 2);
}

/** Secure 6-digit numeric code for SMS one-time passwords. */
function authSecureOtpCode_() {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid(),
    Utilities.Charset.UTF_8);
  var n = 0;
  for (var i = 0; i < 6; i++) n = n * 256 + (digest[i] < 0 ? digest[i] + 256 : digest[i]);
  return String(100000 + (n % 900000));
}

/* ------------------------------------------------------------------- hashing */

function authHmacHex_(message, secret) {
  return authBytesHex_(Utilities.computeHmacSha256Signature(String(message), String(secret)));
}

function authConstantTimeEqual_(a, b) {
  a = String(a || ""); b = String(b || "");
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authPbkdf2Iterations_() {
  var n = Number(authOptionalConfig_("AUTH_PBKDF2_ITERATIONS", "")) || AUTH_PBKDF2_DEFAULT_ITERATIONS_;
  return Math.min(AUTH_PBKDF2_MAX_ITERATIONS_, Math.max(AUTH_PBKDF2_MIN_ITERATIONS_, Math.floor(n)));
}

/**
 * PBKDF2's F function (iterated HMAC-SHA256 with XOR accumulation), producing a
 * single 32-byte block.
 *
 * One deliberate difference from textbook PBKDF2: the HMAC *key* is the pepper
 * and the *message* is salt|password, rather than the other way round. That
 * keeps the peppering property (without the pepper an attacker cannot even
 * begin) while preserving the full stretching cost — verifying one candidate
 * password still requires all `iterations` HMAC rounds.
 */
function authPbkdf2Hex_(password, salt, iterations, pepper) {
  var keyBytes = Utilities.newBlob(String(pepper)).getBytes();
  var message = Utilities.newBlob(String(salt) + "|" + String(password)).getBytes();
  var u = Utilities.computeHmacSha256Signature(message, keyBytes);
  var acc = [];
  for (var i = 0; i < u.length; i++) acc.push(u[i] & 0xff);
  for (var n = 1; n < iterations; n++) {
    u = Utilities.computeHmacSha256Signature(u, keyBytes);
    for (var j = 0; j < acc.length; j++) acc[j] = (acc[j] ^ (u[j] & 0xff)) & 0xff;
  }
  return acc.map(function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
}

/** Run manually in the Apps Script editor to size AUTH_PBKDF2_ITERATIONS. */
function authBenchmarkPbkdf2_() {
  var pepper = authConfig_("AUTH_PASSWORD_PEPPER");
  var probe = 2000, started = Date.now();
  authPbkdf2Hex_("benchmark-password", authRandomHex_(16), probe, pepper);
  var perIteration = (Date.now() - started) / probe;
  return {
    msPer1000Iterations: Math.round(perIteration * 1000),
    currentIterations: authPbkdf2Iterations_(),
    estimatedMsAtCurrent: Math.round(perIteration * authPbkdf2Iterations_()),
    suggestion: "把單次驗證控制在 200–500ms；調整 AUTH_PBKDF2_ITERATIONS 這個 Script Property 即可，舊密碼不會失效。"
  };
}

function authCredentialKey_(userId) { return AUTH_CREDENTIAL_PREFIX_ + String(userId || ""); }

function authSetPasswordCredential_(userId, password) {
  password = String(password || "");
  if (password.length < 8) throw authError_("WEAK_PASSWORD", "密碼至少需要 8 碼");
  if (password.length > 128) throw authError_("WEAK_PASSWORD", "密碼長度不可超過 128 碼");
  var salt = authRandomHex_(16);
  var iterations = authPbkdf2Iterations_();
  var hash = authPbkdf2Hex_(password, salt, iterations, authConfig_("AUTH_PASSWORD_PEPPER"));
  PropertiesService.getScriptProperties().setProperty(
    authCredentialKey_(userId),
    JSON.stringify({
      v: 2,
      alg: "iterated-hmac-sha256-peppered",
      iterations: iterations,
      salt: salt,
      hash: hash,
      updatedAt: new Date().toISOString()
    }));
}

function authDeletePasswordCredential_(userId) {
  PropertiesService.getScriptProperties().deleteProperty(authCredentialKey_(userId));
}

/**
 * Verifies a password and transparently upgrades v1 credentials to v2 on
 * success, so existing accounts migrate to PBKDF2 the next time they log in
 * without anyone having to reset a password.
 *
 * Always performs hashing work, even when the account has no credential, so
 * response time does not reveal whether an account exists.
 */
function authVerifyPasswordCredential_(userId, password) {
  var pepper = authConfig_("AUTH_PASSWORD_PEPPER");
  var raw = PropertiesService.getScriptProperties().getProperty(authCredentialKey_(userId));
  if (!raw) {
    authPbkdf2Hex_(String(password || ""), "absent-account-timing-equalizer",
      authPbkdf2Iterations_(), pepper);
    return false;
  }
  var credential;
  try { credential = JSON.parse(raw); } catch (_) { return false; }

  var salt = String(credential.salt || "");
  var stored = String(credential.hash || "");
  var version = Number(credential.v || 1) || 1;
  var matched = false;

  if (version >= 2) {
    var iterations = Math.min(AUTH_PBKDF2_MAX_ITERATIONS_,
      Math.max(1, Number(credential.iterations || AUTH_PBKDF2_DEFAULT_ITERATIONS_)));
    matched = authConstantTimeEqual_(
      authPbkdf2Hex_(String(password || ""), salt, iterations, pepper), stored);
  } else {
    /* Legacy single-round HMAC. */
    matched = authConstantTimeEqual_(
      authHmacHex_(salt + "|" + String(password || ""), pepper), stored);
  }

  if (!matched) return false;

  var wantsUpgrade = version < 2 ||
    Number(credential.iterations || 0) < authPbkdf2Iterations_();
  if (wantsUpgrade) {
    try { authSetPasswordCredential_(userId, String(password || "")); } catch (_) { /* non-fatal */ }
  }
  return true;
}

function authHasPasswordCredential_(userId) {
  return !!PropertiesService.getScriptProperties().getProperty(authCredentialKey_(userId));
}

/* -------------------------------------------------------------- session token */

function authBase64UrlEncode_(text) {
  return Utilities.base64EncodeWebSafe(String(text), Utilities.Charset.UTF_8).replace(/=+$/g, "");
}

function authBase64UrlDecode_(value) {
  var s = String(value || "");
  while (s.length % 4) s += "=";
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString("UTF-8");
}

function authSessionVersion_(userId) {
  var raw = PropertiesService.getScriptProperties().getProperty(AUTH_SESSION_VERSION_PREFIX_ + String(userId || ""));
  return Math.max(1, Number(raw || 1) || 1);
}

function authBumpSessionVersion_(userId) {
  var next = authSessionVersion_(userId) + 1;
  PropertiesService.getScriptProperties().setProperty(
    AUTH_SESSION_VERSION_PREFIX_ + String(userId || ""), String(next));
  return next;
}

function authIssueSessionToken_(userId) {
  var now = Math.floor(Date.now() / 1000);
  var payload = {
    v: 2,
    userId: String(userId),
    sv: authSessionVersion_(userId),
    iat: now,
    exp: now + AUTH_SESSION_TTL_SECONDS_,
    nonce: authRandomHex_(16)
  };
  var body = authBase64UrlEncode_(JSON.stringify(payload));
  var sig = authHmacHex_(body, authConfig_("AUTH_SESSION_SECRET"));
  return body + "." + sig;
}

function authVerifySessionToken_(token) {
  var parts = String(token || "").split(".");
  if (parts.length !== 2) throw authError_("SESSION_INVALID", "登入工作階段無效，請重新登入");
  var expected = authHmacHex_(parts[0], authConfig_("AUTH_SESSION_SECRET"));
  if (!authConstantTimeEqual_(expected, parts[1])) throw authError_("SESSION_INVALID", "登入工作階段簽章無效，請重新登入");
  var payload;
  try { payload = JSON.parse(authBase64UrlDecode_(parts[0])); }
  catch (_) { throw authError_("SESSION_INVALID", "登入工作階段格式錯誤"); }
  var now = Math.floor(Date.now() / 1000);
  if (!payload.userId || Number(payload.exp || 0) <= now) throw authError_("SESSION_EXPIRED", "登入工作階段已過期，請重新登入");
  if (Number(payload.sv || 1) !== authSessionVersion_(payload.userId)) throw authError_("SESSION_INVALID", "登入工作階段已失效，請重新登入");
  return payload;
}

/* --------------------------------------------------------------- rate limiting */

/** Opaque, non-reversible key so phone numbers and IPs are never stored raw. */
function authOpaqueKey_(value) {
  return authHmacHex_(String(value || ""), authConfig_("AUTH_SESSION_SECRET")).substring(0, 40);
}
function authOpaquePhoneKey_(phone) { return authOpaqueKey_("phone:" + String(phone || "")); }
function authOpaqueIpKey_(ip) { return authOpaqueKey_("ip:" + String(ip || "")); }

function authLoginRateKey_(phone) { return AUTH_LOGIN_RATE_PREFIX_ + authOpaquePhoneKey_(phone); }
function authLoginIpRateKey_(ip) { return AUTH_LOGIN_IP_RATE_PREFIX_ + authOpaqueIpKey_(ip); }

function authReadJsonProperty_(key) {
  var raw = PropertiesService.getScriptProperties().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}
function authWriteJsonProperty_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(value));
}

function authLoginRateState_(phone) {
  var now = Math.floor(Date.now() / 1000);
  var key = authLoginRateKey_(phone);
  var state = authReadJsonProperty_(key) || { failures: 0, windowStartedAt: now, lockedUntil: 0 };
  /* A finished lock plus an elapsed window resets the counter. Nothing is
   * permanent, so a third party cannot lock an account out indefinitely. */
  if (Number(state.lockedUntil || 0) <= now &&
      now - Number(state.windowStartedAt || 0) > AUTH_LOGIN_WINDOW_SECONDS_) {
    state = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
  }
  return { key: key, state: state, now: now };
}

function authLoginIpState_(ip) {
  var now = Math.floor(Date.now() / 1000);
  var key = authLoginIpRateKey_(ip);
  var state = authReadJsonProperty_(key) || { failures: 0, windowStartedAt: now, lockedUntil: 0 };
  if (Number(state.lockedUntil || 0) <= now &&
      now - Number(state.windowStartedAt || 0) > AUTH_LOGIN_IP_WINDOW_SECONDS_) {
    state = { failures: 0, windowStartedAt: now, lockedUntil: 0 };
  }
  return { key: key, state: state, now: now };
}

function authRateLimitedError_(retryAfterSeconds) {
  var e = authError_("LOGIN_RATE_LIMITED", "登入嘗試過於頻繁，請稍後再試");
  e.retryAfterSeconds = Math.max(1, Number(retryAfterSeconds) || 1);
  return e;
}

function authAssertLoginAllowed_(phone, sourceIp) {
  var x = authLoginRateState_(phone);
  if (Number(x.state.lockedUntil || 0) > x.now) {
    throw authRateLimitedError_(Number(x.state.lockedUntil) - x.now);
  }
  if (sourceIp) {
    var ipState = authLoginIpState_(sourceIp);
    if (Number(ipState.state.lockedUntil || 0) > ipState.now) {
      throw authRateLimitedError_(Number(ipState.state.lockedUntil) - ipState.now);
    }
  }
  return x.state;
}

function authLockSecondsForFailures_(failures) {
  var lock = 0;
  AUTH_LOGIN_LOCK_STEPS_.forEach(function (step) {
    if (failures >= step.failures) lock = step.lockSeconds;
  });
  return Math.min(AUTH_LOGIN_MAX_LOCK_SECONDS_, lock);
}

function authRecordLoginFailure_(phone, sourceIp) {
  var x = authLoginRateState_(phone), state = x.state;
  state.failures = Math.max(0, Number(state.failures) || 0) + 1;
  state.lastFailureAt = x.now;
  var lockSeconds = authLockSecondsForFailures_(state.failures);
  if (lockSeconds > 0) state.lockedUntil = x.now + lockSeconds;
  authWriteJsonProperty_(x.key, state);

  if (sourceIp) {
    var ipCtx = authLoginIpState_(sourceIp), ipState = ipCtx.state;
    ipState.failures = Math.max(0, Number(ipState.failures) || 0) + 1;
    ipState.lastFailureAt = ipCtx.now;
    if (ipState.failures >= AUTH_LOGIN_IP_MAX_FAILURES_) {
      ipState.lockedUntil = ipCtx.now + AUTH_LOGIN_IP_LOCK_SECONDS_;
      ipState.failures = 0;
      ipState.windowStartedAt = ipCtx.now;
    }
    authWriteJsonProperty_(ipCtx.key, ipState);
  }
  return state;
}

function authClearLoginRate_(phone) {
  PropertiesService.getScriptProperties().deleteProperty(authLoginRateKey_(phone));
}

/* ------------------------------------------------------------- password reset */

function authResetChallengeKey_(phone) { return AUTH_RESET_CHALLENGE_PREFIX_ + authOpaquePhoneKey_(phone); }
function authResetRateKey_(phone) { return AUTH_RESET_RATE_PREFIX_ + authOpaquePhoneKey_(phone); }

/**
 * Throttles reset requests per phone number. Without this, anyone who knows a
 * user's number can make the platform send them unlimited SMS at the
 * operator's expense.
 */
function authAssertResetRequestAllowed_(phone) {
  var now = Math.floor(Date.now() / 1000);
  var key = authResetRateKey_(phone);
  var state = authReadJsonProperty_(key) || { count: 0, windowStartedAt: now, lastSentAt: 0 };
  if (now - Number(state.windowStartedAt || 0) > AUTH_RESET_WINDOW_SECONDS_) {
    state = { count: 0, windowStartedAt: now, lastSentAt: Number(state.lastSentAt || 0) };
  }
  var sinceLast = now - Number(state.lastSentAt || 0);
  if (Number(state.lastSentAt || 0) && sinceLast < AUTH_RESET_MIN_INTERVAL_SECONDS_) {
    var e = authError_("RESET_RATE_LIMITED", "驗證碼剛剛已寄出，請稍候再重新索取");
    e.retryAfterSeconds = AUTH_RESET_MIN_INTERVAL_SECONDS_ - sinceLast;
    throw e;
  }
  if (Number(state.count || 0) >= AUTH_RESET_MAX_PER_WINDOW_) {
    var e2 = authError_("RESET_RATE_LIMITED", "重設密碼索取次數過多，請稍後再試");
    e2.retryAfterSeconds = Math.max(1, AUTH_RESET_WINDOW_SECONDS_ - (now - Number(state.windowStartedAt || 0)));
    throw e2;
  }
  return { key: key, state: state, now: now };
}

function authRecordResetRequestSent_(rateCtx) {
  var state = rateCtx.state;
  state.count = Math.max(0, Number(state.count) || 0) + 1;
  state.lastSentAt = rateCtx.now;
  authWriteJsonProperty_(rateCtx.key, state);
}

/** Returns the live challenge for this phone, or null when none is valid. */
function authActiveResetChallenge_(phone) {
  var state = authReadJsonProperty_(authResetChallengeKey_(phone));
  if (!state) return null;
  var now = Math.floor(Date.now() / 1000);
  if (Number(state.expiresAt || 0) <= now) return null;
  return { state: state, expiresInSeconds: Number(state.expiresAt) - now };
}

function authSendPasswordResetSms_(phone, code) {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty("PASSWORD_RESET_SMS_WEBHOOK_URL") || "").trim();
  var secret = String(props.getProperty("PASSWORD_RESET_SMS_WEBHOOK_SECRET") || "").trim();
  if (!url || !/^https:\/\//i.test(url) || !secret) {
    throw authError_("RESET_PROVIDER_UNAVAILABLE", "正式簡訊密碼重設服務尚未設定");
  }
  var payload = { phone: String(phone), message: "安心接送密碼重設驗證碼：" + String(code) + "（5 分鐘內有效）" };
  var response = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    headers: { "X-Care-Ride-Secret": secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var status = Number(response.getResponseCode());
  if (status < 200 || status >= 300) {
    throw authError_("RESET_PROVIDER_UNAVAILABLE", "簡訊服務暫時無法使用，請稍後再試");
  }
}

function authCreatePasswordResetChallenge_(userId, phone) {
  /* An unexpired challenge is reused rather than re-sent, so repeated taps on
   * "resend" cost neither an SMS nor an error message — the user is simply
   * told how long the code they already have is still valid. Checked before
   * the rate limit so a legitimate resend never hits a throttle error. */
  var active = authActiveResetChallenge_(phone);
  if (active && String(active.state.userId) === String(userId)) {
    return { expiresInSeconds: active.expiresInSeconds, resent: false };
  }

  var rateCtx = authAssertResetRequestAllowed_(phone);
  var code = authSecureOtpCode_();
  var now = Math.floor(Date.now() / 1000);
  var salt = authRandomHex_(16);
  var hash = authPbkdf2Hex_(code, salt, AUTH_PBKDF2_MIN_ITERATIONS_, authConfig_("AUTH_PASSWORD_PEPPER"));
  var state = {
    v: 2,
    userId: String(userId),
    phone: String(phone),
    salt: salt,
    hash: hash,
    iterations: AUTH_PBKDF2_MIN_ITERATIONS_,
    expiresAt: now + AUTH_RESET_TTL_SECONDS_,
    attempts: 0,
    createdAt: now
  };
  authWriteJsonProperty_(authResetChallengeKey_(phone), state);
  try {
    authSendPasswordResetSms_(phone, code);
  } catch (e) {
    PropertiesService.getScriptProperties().deleteProperty(authResetChallengeKey_(phone));
    throw e;
  }
  authRecordResetRequestSent_(rateCtx);
  return { expiresInSeconds: AUTH_RESET_TTL_SECONDS_, resent: true };
}

function authVerifyPasswordResetChallenge_(phone, code) {
  var key = authResetChallengeKey_(phone);
  var state = authReadJsonProperty_(key);
  var now = Math.floor(Date.now() / 1000);
  if (!state) throw authError_("RESET_CODE_INVALID", "驗證碼無效或已失效");
  if (Number(state.expiresAt || 0) <= now) {
    PropertiesService.getScriptProperties().deleteProperty(key);
    throw authError_("RESET_CODE_INVALID", "驗證碼已過期，請重新取得");
  }
  state.attempts = Math.max(0, Number(state.attempts) || 0) + 1;
  if (state.attempts > AUTH_RESET_MAX_ATTEMPTS_) {
    PropertiesService.getScriptProperties().deleteProperty(key);
    throw authError_("RESET_CODE_INVALID", "驗證碼錯誤次數過多，請重新取得");
  }
  var pepper = authConfig_("AUTH_PASSWORD_PEPPER");
  var expected = Number(state.v || 1) >= 2
    ? authPbkdf2Hex_(String(code || ""), String(state.salt || ""),
        Math.max(1, Number(state.iterations || AUTH_PBKDF2_MIN_ITERATIONS_)), pepper)
    : authHmacHex_(String(state.salt || "") + "|" + String(code || ""), pepper);
  if (!authConstantTimeEqual_(expected, String(state.hash || ""))) {
    authWriteJsonProperty_(key, state);
    throw authError_("RESET_CODE_INVALID", "驗證碼錯誤");
  }
  return { key: key, state: state };
}

/* ------------------------------------------------------------------ identities */

function authIsEnabled_(value) {
  return value === true ||
    String(value || "").trim().toLowerCase() === "true" ||
    String(value || "").trim() === "1" ||
    String(value || "").trim() === "是";
}

function authMembershipsForUser_(userId) {
  return readTable_("成員資格").filter(function (m) {
    return String(m["使用者ID"]) === String(userId) &&
      String(m["狀態"] || "").toLowerCase() === "active";
  });
}

function authPublicMembership_(m) {
  return {
    membershipId: String(m["成員資格ID"] || ""),
    organizationId: String(m["組織ID"] || ""),
    role: String(m["角色"] || ""),
    status: String(m["狀態"] || "")
  };
}

function authPublicUser_(u) {
  return {
    userId: String(u["使用者ID"] || ""),
    displayName: String(u["顯示名稱"] || ""),
    phone: normalizeTaiwanPhoneForIdentity_(u["手機號碼(E.164)"]),
    email: String(u["電子郵件"] || "").trim().toLowerCase(),
    platformRole: String(u["平台角色"] || "none").trim().toLowerCase() || "none"
  };
}

function authUpdateObjectRowByKey_(sheetName, keyHeader, keyValue, updates) {
  var sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error("找不到工作表：" + sheetName);
  var values = sheet.getDataRange().getValues();
  if (!values.length) throw new Error("工作表沒有資料：" + sheetName);
  var headers = values[0].map(function (v) { return String(v || "").trim(); });
  var keyIndex = headers.indexOf(keyHeader);
  if (keyIndex < 0) throw new Error("缺少欄位：" + keyHeader);
  var rowIndex = -1;
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][keyIndex]) === String(keyValue)) { rowIndex = r + 1; break; }
  }
  if (rowIndex < 0) throw new Error("找不到要更新的資料");
  /* Single batched write instead of one setValue() round trip per field. */
  var row = values[rowIndex - 1].slice();
  var touched = false;
  Object.keys(updates || {}).forEach(function (h) {
    var c = headers.indexOf(h);
    if (c >= 0) { row[c] = updates[h]; touched = true; }
  });
  if (touched) sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
}

function authBackendOrganizationId_(id) {
  id = String(id || "").trim();
  return id === "org_requesters" ? "ORG-REQ-001" : id;
}

function authAuthorizeStaffCreate_(sessionToken, organizationId, role) {
  var sessionPayload = authVerifySessionToken_(sessionToken), actorId = sessionPayload.userId;
  var actor = readTable_("使用者").find(function (u) { return String(u["使用者ID"]) === actorId; });
  if (!actor || !authIsEnabled_(actor["啟用狀態"])) throw authError_("FORBIDDEN", "目前帳號無法執行此操作");
  var platformRole = String(actor["平台角色"] || "").trim().toLowerCase();
  if (platformRole === "super_admin") return { actor: actor, actorId: actorId, isSuperAdmin: true };
  var membership = authMembershipsForUser_(actorId).find(function (m) {
    return String(m["組織ID"]) === organizationId && String(m["角色"]) === "owner";
  });
  if (!membership) throw authError_("FORBIDDEN", "只有平台超級管理者或該公司負責人可以新增公司人員");
  if (role === "owner") throw authError_("FORBIDDEN", "公司負責人只能新增司機或調度人員");
  return { actor: actor, actorId: actorId, isSuperAdmin: false, membership: membership };
}

/* --------------------------------------------------------------- bootstrapping */

/**
 * Run once manually in the Apps Script editor before production launch.
 * Do not keep the password in source code; type it only into the Run
 * invocation, or use authBootstrapSuperAdminFromProperties_() below.
 */
function authBootstrapSuperAdminPassword_(phone, password) {
  phone = String(phone || "").replace(/\D/g, "");
  if (!/^09\d{8}$/.test(phone)) throw new Error("手機格式錯誤");
  if (String(password || "").length < 12) throw new Error("超級管理者正式密碼至少 12 碼");
  var user = readTable_("使用者").find(function (u) {
    return String(u["平台角色"] || "").trim().toLowerCase() === "super_admin";
  });
  if (!user) throw new Error("找不到 super_admin 使用者");
  var userId = String(user["使用者ID"]);
  authUpdateObjectRowByKey_("使用者", "使用者ID", userId, {
    "手機號碼(E.164)": "+886" + phone.substring(1),
    "驗證提供者": "password",
    "驗證主體ID": "password:" + userId,
    "更新時間": new Date().toISOString()
  });
  authSetPasswordCredential_(userId, password);
  authBumpSessionVersion_(userId);
  authClearLoginRate_(phone);
  return { ok: true, userId: userId, phone: phone };
}

/**
 * One-time production bootstrap without placing the password in source code.
 * Set BOOTSTRAP_SUPERADMIN_PHONE and BOOTSTRAP_SUPERADMIN_PASSWORD in Script
 * Properties, run this function once, then both temporary properties are
 * deleted even when the bootstrap fails.
 */
function authBootstrapSuperAdminFromProperties_() {
  var props = PropertiesService.getScriptProperties();
  var phone = String(props.getProperty("BOOTSTRAP_SUPERADMIN_PHONE") || "").trim();
  var password = String(props.getProperty("BOOTSTRAP_SUPERADMIN_PASSWORD") || "");
  if (!phone || !password) throw new Error("缺少超級管理者的一次性初始化設定");
  try {
    return authBootstrapSuperAdminPassword_(phone, password);
  } finally {
    props.deleteProperty("BOOTSTRAP_SUPERADMIN_PHONE");
    props.deleteProperty("BOOTSTRAP_SUPERADMIN_PASSWORD");
  }
}

/* Backwards-compatible aliases for the previously versioned function names. */
function bootstrapSuperAdminPassword_v12_25_77(phone, password) {
  return authBootstrapSuperAdminPassword_(phone, password);
}
function bootstrapSuperAdminFromProperties_v12_25_79() {
  return authBootstrapSuperAdminFromProperties_();
}
