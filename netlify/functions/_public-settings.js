'use strict';

/** 登入方式開關與客服聯絡（#79）：未登入也能讀的兩組平台設定，見 0015。 */

async function publicSettings(client) {
  return (await client.query('select app.public_settings() as s')).rows[0].s;
}

/** 這個社群登入方式目前有沒有開放 */
async function loginMethodEnabled(client, provider) {
  const s = await publicSettings(client);
  return Boolean(s && s.loginMethods && s.loginMethods[provider] === true);
}

module.exports = { publicSettings, loginMethodEnabled };
