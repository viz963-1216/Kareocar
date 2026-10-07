/**
 * 隱私權政策的聯絡 Email（#79）：讀平台設定的客服聯絡（/api/v2/public-settings），
 * 填進 [data-support-email]。平台管理者還沒填時保留頁面上的「待填」文字。
 */
(function () {
  'use strict';
  fetch('/api/v2/public-settings', { cache: 'no-store', credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      var email = j && j.ok && j.data && j.data.supportContact && j.data.supportContact.email;
      if (!email) return;
      document.querySelectorAll('[data-support-email]').forEach(function (el) {
        var a = document.createElement('a');
        a.href = 'mailto:' + email;
        a.textContent = email;
        el.textContent = '';
        el.classList.remove('todo');
        el.appendChild(a);
      });
    })
    .catch(function () { /* 讀不到就保留原本的文字 */ });
})();
