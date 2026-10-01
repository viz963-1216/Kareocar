'use strict';

/**
 * POST /api/v2/geocode-check  —— 送出預約前先檢查地址找不找得到
 *
 * body: { pickupAddress, destination }
 *
 * 只給前端在送出前提示用：回傳兩個地址的模糊地址、距離與車程。寫入預約時伺服器
 * 會再算一次（見 v2-state-mutate 的 serverComputed），這裡的結果不會被存下來。
 * 必須登入，避免被當成免費的地址查詢服務。
 */

const { runAuthenticated, optionalText } = require('./_business-rpc');
const geo = require('./_geo');

exports.handler = (event) => runAuthenticated(event, async (client, body) => {
  const computed = await geo.computeBookingGeo(optionalText(body.pickupAddress, 300), optionalText(body.destination, 300));
  return {
    pickup: { district: computed.pickup.district, fuzzyAddress: computed.pickup.fuzzyAddress },
    destination: { district: computed.destination.district, fuzzyAddress: computed.destination.fuzzyAddress },
    distanceMeters: computed.distanceMeters,
    durationSeconds: computed.durationSeconds
  };
});
