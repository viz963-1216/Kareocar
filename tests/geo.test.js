'use strict';
/**
 * netlify/functions/_geo.js 的離線測試：模糊地址、Google 回應解析、Google 呼叫格式。
 * 不連網：fetch 以假回應取代。
 */
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.GOOGLE_MAPS_API_KEY = 'offline-test-key';
const geo = require(path.join(__dirname, '..', 'netlify', 'functions', '_geo.js'));

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };
const rejects = async (p, code) => {
  try { await p; } catch (e) { assert.equal(e.code, code, `預期 ${code}，實得 ${e.code}：${e.message}`); return e; }
  assert.fail(`預期 ${code}，實際通過`);
};
const comp = (long_name, ...types) => ({ long_name, types });
const googleResult = (components, loc = { lat: 25.04, lng: 121.51 }) => ({
  status: 'OK', results: [{ address_components: components, geometry: { location: loc }, formatted_address: 'X' }]
});

(async () => {
  console.log('--- 模糊地址 ---');
  await ok('門牌去尾：個位數不顯示、二位數 1x、三位數 1xx', () => {
    assert.equal(geo.maskStreetNumber('5'), '');
    assert.equal(geo.maskStreetNumber('12'), '1x號');
    assert.equal(geo.maskStreetNumber('188'), '1xx號');
    assert.equal(geo.maskStreetNumber('25之3'), '2x號');
    assert.equal(geo.maskStreetNumber(''), '');
  });
  await ok('模糊地址只有行政區＋路段＋去尾門牌，不含完整門牌', () => {
    const f = geo.fuzzyAddress({ district: '臺北市中正區', route: '中正路二段', streetNumber: '188' });
    assert.equal(f, '臺北市中正區中正路二段1xx號附近');
    assert.ok(!f.includes('188'));
  });
  await ok('地址雜湊：前後空白不影響，內容不同就不同', () => {
    assert.equal(geo.addressHash(' 甲 ', '乙'), geo.addressHash('甲', '乙'));
    assert.notEqual(geo.addressHash('甲', '乙'), geo.addressHash('甲', '丙'));
  });
  await ok('伺服器報價：待定價、沒有金額', () => {
    const q = geo.serverQuote();
    assert.equal(q.status, 'pricing_pending');
    assert.equal(q.estimatedFare, null);
  });

  console.log('--- Google 回應解析 ---');
  await ok('完整地址：取出縣市＋行政區、路段、門牌、座標', () => {
    const r = geo.parseGoogleGeocode(googleResult([
      comp('188', 'street_number'), comp('文化路一段', 'route'),
      comp('板橋區', 'administrative_area_level_2', 'political'), comp('新北市', 'administrative_area_level_1', 'political')
    ]), 'x');
    assert.deepEqual([r.district, r.route, r.streetNumber, r.lat], ['新北市板橋區', '文化路一段', '188', 25.04]);
  });
  await ok('ZERO_RESULTS → ADDRESS_NOT_FOUND', () => rejects(Promise.resolve().then(() => geo.parseGoogleGeocode({ status: 'ZERO_RESULTS', results: [] }, 'x')), 'ADDRESS_NOT_FOUND'));
  await ok('只定位到行政區（沒有路段）→ ADDRESS_NOT_FOUND', () => rejects(Promise.resolve().then(() =>
    geo.parseGoogleGeocode(googleResult([comp('板橋區', 'administrative_area_level_2'), comp('新北市', 'administrative_area_level_1')]), 'x')), 'ADDRESS_NOT_FOUND'));
  await ok('金鑰錯誤等非 OK 狀態 → GEO_PROVIDER_UNAVAILABLE', () => rejects(Promise.resolve().then(() =>
    geo.parseGoogleGeocode({ status: 'REQUEST_DENIED', results: [{}] }, 'x')), 'GEO_PROVIDER_UNAVAILABLE'));
  await ok('路線：距離與車程（"1234s"）', () => {
    assert.deepEqual(geo.parseGoogleRoute({ routes: [{ distanceMeters: 5300, duration: '780s' }] }), { distanceMeters: 5300, durationSeconds: 780 });
  });
  await ok('沒有路線 → ROUTE_NOT_FOUND', () => rejects(Promise.resolve().then(() => geo.parseGoogleRoute({ routes: [] })), 'ROUTE_NOT_FOUND'));

  console.log('--- Google 呼叫格式與整體計算 ---');
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    if (String(url).includes('geocode')) {
      const address = new URL(url).searchParams.get('address');
      const body = address.includes('找不到') ? { status: 'ZERO_RESULTS', results: [] } : googleResult([
        comp('20', 'street_number'), comp('公園路', 'route'),
        comp('中正區', 'administrative_area_level_2'), comp('臺北市', 'administrative_area_level_1')]);
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response(JSON.stringify({ routes: [{ distanceMeters: 4200, duration: '600s' }] }), { status: 200 });
  };
  try {
    await ok('定位兩個地址＋一次路線，產生 serverComputed', async () => {
      const r = await geo.computeBookingGeo('臺北市中正區公園路20號', '臺北市中正區公園路20號');
      assert.equal(r.pickup.fuzzyAddress, '臺北市中正區公園路2x號附近');
      assert.deepEqual([r.distanceMeters, r.durationSeconds], [4200, 600]);
      assert.equal(seen.filter((s) => s.url.includes('geocode')).length, 2);
      assert.equal(seen.filter((s) => s.url.includes('computeRoutes')).length, 1);
    });
    await ok('Geocoding 帶 zh-TW、tw；Routes 帶金鑰標頭與欄位遮罩（不把金鑰放在 Routes 網址）', () => {
      const g = new URL(seen.find((s) => s.url.includes('geocode')).url);
      assert.equal(g.searchParams.get('language'), 'zh-TW');
      assert.equal(g.searchParams.get('region'), 'tw');
      const r = seen.find((s) => s.url.includes('computeRoutes'));
      assert.equal(r.init.headers['X-Goog-Api-Key'], 'offline-test-key');
      assert.equal(r.init.headers['X-Goog-FieldMask'], 'routes.distanceMeters,routes.duration');
      assert.ok(!r.url.includes('offline-test-key'));
    });
    await ok('目的地找不到 → ADDRESS_NOT_FOUND，並指出是 destination', async () => {
      const e = await rejects(geo.computeBookingGeo('臺北市中正區公園路20號', '找不到的地方'), 'ADDRESS_NOT_FOUND');
      assert.equal(e.field, 'destination');
    });
    await ok('地址空白 → ADDRESS_NOT_FOUND（不呼叫 Google）', async () => {
      const before = seen.length;
      const e = await rejects(geo.computeBookingGeo('', 'x'), 'ADDRESS_NOT_FOUND');
      assert.equal(e.field, 'pickupAddress');
      assert.equal(seen.length, before);
    });
    await ok('沒有設定金鑰 → CONFIG_MISSING', async () => {
      delete process.env.GOOGLE_MAPS_API_KEY;
      await rejects(geo.computeBookingGeo('a路1號', 'b路2號'), 'CONFIG_MISSING');
      process.env.GOOGLE_MAPS_API_KEY = 'offline-test-key';
    });
  } finally { global.fetch = realFetch; }

  console.log(`geo: ${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
