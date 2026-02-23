const API_URL          = "https://open.er-api.com/v6/latest/CAD";
const FALLBACK_API_URL = "https://api.frankfurter.app/latest?from=CAD";
const STORAGE_KEY      = "cadRateCache";
const TTL_MS           = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches all CAD cross-rates from the primary API (open.er-api.com).
 * @returns {Promise<{rates: Object, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function fetchCadRates() {
  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Rate fetch failed (${res.status})`);
  const data = await res.json();

  // Expected shape: { result: "success", base_code: "CAD", rates: { EUR: <number>, GBP: ..., ... } }
  if (data?.result !== "success" || data?.base_code !== "CAD" || typeof data?.rates?.EUR !== "number") {
    throw new Error("Unexpected rate response");
  }

  return {
    rates: data.rates,
    fetchedAt: Date.now(),
    apiTimeLastUpdateUtc: data.time_last_update_utc ?? null,
  };
}

/**
 * Fetches all CAD cross-rates from the Frankfurter fallback API.
 * Response shape: { rates: { EUR: number, GBP: number, ... }, date: "YYYY-MM-DD" }
 * @returns {Promise<{rates: Object, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function fetchFromFallback() {
  const res = await fetch(FALLBACK_API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fallback rate fetch failed (${res.status})`);
  const data = await res.json();

  if (typeof data?.rates?.EUR !== "number") {
    throw new Error("Unexpected fallback rate response");
  }

  return {
    rates: data.rates,
    fetchedAt: Date.now(),
    apiTimeLastUpdateUtc: data.date ?? null,
  };
}

/**
 * Returns a cached rates object if it is less than 24 hours old,
 * otherwise fetches fresh rates (primary API → fallback API → stale cache).
 * @returns {Promise<{rates: Object, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function getCachedOrFreshRates() {
  const { [STORAGE_KEY]: cache } = await chrome.storage.local.get(STORAGE_KEY);

  if (cache?.rates && cache?.fetchedAt && (Date.now() - cache.fetchedAt) < TTL_MS) {
    return cache;
  }

  try {
    const fresh = await fetchCadRates();
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    return fresh;
  } catch {
    try {
      const fresh = await fetchFromFallback();
      await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
      return fresh;
    } catch {
      // Fail-open: serve stale cache if it exists at all, rather than breaking conversion
      if (cache?.rates) return cache;
      throw new Error("All rate sources failed and no cached rate available");
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_CAD_RATES") return;

  getCachedOrFreshRates()
    .then((cache) => sendResponse({
      ok: true,
      rates: cache.rates,
      fetchedAt: cache.fetchedAt,
      apiTimeLastUpdateUtc: cache.apiTimeLastUpdateUtc,
    }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keep message channel open for async sendResponse
});
