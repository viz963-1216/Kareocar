'use strict';

/**
 * 地址定位與路線的窄介面，以及預約上「伺服器計算欄位」的產生。
 *
 *   geocode(address)  → { lat, lng, district, route, streetNumber, formattedAddress }
 *   route(from, to)   → { distanceMeters, durationSeconds }
 *
 * 正式實作是 Google Maps（Geocoding API、Routes API），環境變數 GOOGLE_MAPS_API_KEY。
 * 測試時用 setProvider() 換成假的實作。只在建立預約或地址被改時呼叫，結果存進預約，
 * 瀏覽需求池不會再呼叫。
 *
 * 需求池只露出「模糊地址」：行政區＋路段＋門牌去尾（例如 臺北市中正區中正路二段1xx號附近），
 * 不露出完整門牌。
 */

const crypto = require('crypto');

const REQUEST_TIMEOUT_MS = 8_000;
const SCHEMA_VERSION = 1;

function geoError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/* ---------------------------------------------------------------- Google */

function apiKey() {
  const key = String(process.env.GOOGLE_MAPS_API_KEY || '').trim();
  if (!key) throw geoError('CONFIG_MISSING', 'Netlify 尚未設定 GOOGLE_MAPS_API_KEY');
  return key;
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  } catch (error) {
    throw geoError('GEO_PROVIDER_UNAVAILABLE', '地址定位服務暫時無法使用，請稍後再試');
  } finally {
    clearTimeout(timer);
  }
}

function component(result, type) {
  const c = (result.address_components || []).find((x) => (x.types || []).includes(type));
  return c ? String(c.long_name || '') : '';
}

/** Google Geocoding 回應 → 我們的形狀。只接受定位到路段以上精度的結果。 */
function parseGoogleGeocode(data, address) {
  if (!data || data.status === 'ZERO_RESULTS' || !Array.isArray(data.results) || !data.results.length) {
    throw geoError('ADDRESS_NOT_FOUND', `找不到這個地址：${address}`);
  }
  if (data.status && data.status !== 'OK') {
    throw geoError('GEO_PROVIDER_UNAVAILABLE', '地址定位服務暫時無法使用，請稍後再試');
  }
  const r = data.results[0];
  const city = component(r, 'administrative_area_level_1');
  const area = component(r, 'administrative_area_level_2') || component(r, 'administrative_area_level_3')
    || component(r, 'locality');
  const route = component(r, 'route');
  if (!route) {
    // 只定位到行政區或城市，不足以算距離或給接送參考
    throw geoError('ADDRESS_NOT_FOUND', `地址不夠完整，請包含路名與門牌：${address}`);
  }
  const loc = (r.geometry && r.geometry.location) || {};
  return {
    lat: Number(loc.lat), lng: Number(loc.lng),
    district: `${city}${area}`,
    route,
    streetNumber: component(r, 'street_number'),
    formattedAddress: String(r.formatted_address || '')
  };
}

/** Routes API 回應 → { distanceMeters, durationSeconds }。 */
function parseGoogleRoute(data) {
  const route = data && Array.isArray(data.routes) ? data.routes[0] : null;
  if (!route || !Number.isFinite(Number(route.distanceMeters))) {
    throw geoError('ROUTE_NOT_FOUND', '找不到兩個地址之間的行車路線');
  }
  const seconds = Number(String(route.duration || '').replace(/s$/, ''));
  return { distanceMeters: Number(route.distanceMeters), durationSeconds: Number.isFinite(seconds) ? seconds : null };
}

const googleProvider = {
  async geocode(address) {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?'
      + new URLSearchParams({ address, key: apiKey(), language: 'zh-TW', region: 'tw' });
    const { data } = await fetchJson(url);
    return parseGoogleGeocode(data, address);
  },
  async route(from, to) {
    const { status, data } = await fetchJson('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': apiKey(),
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
        destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
        travelMode: 'DRIVE'
      })
    });
    if (status >= 500) throw geoError('GEO_PROVIDER_UNAVAILABLE', '路線服務暫時無法使用，請稍後再試');
    return parseGoogleRoute(data);
  }
};

let provider = googleProvider;
function setProvider(next) { provider = next || googleProvider; }

/* ------------------------------------------------------- 模糊地址與預約欄位 */

/** 門牌去尾：12 → 1x號、123 → 1xx號；個位數門牌不顯示。 */
function maskStreetNumber(streetNumber) {
  const digits = String(streetNumber || '').match(/\d+/);
  if (!digits || digits[0].length < 2) return '';
  const n = digits[0];
  return `${n[0]}${'x'.repeat(n.length - 1)}號`;
}

function fuzzyAddress(place) {
  return `${place.district}${place.route}${maskStreetNumber(place.streetNumber)}附近`;
}

function addressKey(pickupAddress, destination) {
  return crypto.createHash('sha256')
    .update(`${String(pickupAddress || '').trim()}\u0000${String(destination || '').trim()}`).digest('hex');
}

/** 報價：平台目前不定車資（需求者與機構自行議定），由伺服器標示待定價，不產生金額。 */
function serverQuote() {
  return { status: 'pricing_pending', currency: 'TWD', estimatedFare: null,
    explanation: '平台目前不訂定車資，由需求者與承接機構議定。' };
}

/**
 * 定位上下車地址、計算路線，產生預約的 serverComputed。地址找不到時丟 ADDRESS_NOT_FOUND，
 * 並帶 field 指出是哪一個地址。
 */
async function computeBookingGeo(pickupAddress, destination) {
  const pickupText = String(pickupAddress || '').trim();
  const destinationText = String(destination || '').trim();
  if (!pickupText) throw geoError('ADDRESS_NOT_FOUND', '請輸入上車地址', { field: 'pickupAddress' });
  if (!destinationText) throw geoError('ADDRESS_NOT_FOUND', '請輸入目的地', { field: 'destination' });

  const locate = async (text, field) => {
    try { return await provider.geocode(text); } catch (error) {
      if (error.code === 'ADDRESS_NOT_FOUND') error.field = field;
      throw error;
    }
  };
  const pickup = await locate(pickupText, 'pickupAddress');
  const dest = await locate(destinationText, 'destination');
  const route = await provider.route(pickup, dest);

  const place = (p) => ({
    lat: p.lat, lng: p.lng, district: p.district, fuzzyAddress: fuzzyAddress(p)
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    addressKey: addressKey(pickupText, destinationText),
    pickup: place(pickup),
    destination: place(dest),
    distanceMeters: route.distanceMeters,
    durationSeconds: route.durationSeconds,
    quote: serverQuote(),
    computedAt: new Date().toISOString()
  };
}

module.exports = {
  computeBookingGeo, addressKey, fuzzyAddress, maskStreetNumber, serverQuote,
  parseGoogleGeocode, parseGoogleRoute, setProvider
};
