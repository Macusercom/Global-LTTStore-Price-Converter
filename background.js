const API_URL         = "https://open.er-api.com/v6/latest/CAD";
const FALLBACK_API_URL = "https://api.frankfurter.app/latest?from=CAD&to=EUR";
const STORAGE_KEY      = "cadEurRateCache";
const TTL_MS           = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetches the CAD→EUR rate from the primary API (open.er-api.com).
 * @returns {Promise<{rate: number, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function fetchCadToEurRate() {
  const res = await fetch(API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Rate fetch failed (${res.status})`);
  const data = await res.json();

  // Expected shape: { result: "success", base_code: "CAD", rates: { EUR: <number>, ... } }
  if (data?.result !== "success" || data?.base_code !== "CAD" || typeof data?.rates?.EUR !== "number") {
    throw new Error("Unexpected rate response");
  }

  return {
    rate: data.rates.EUR,
    fetchedAt: Date.now(),
    apiTimeLastUpdateUtc: data.time_last_update_utc ?? null
  };
}

/**
 * Fetches the CAD→EUR rate from the Frankfurter fallback API.
 * Response shape: { rates: { EUR: number }, date: "YYYY-MM-DD" }
 * @returns {Promise<{rate: number, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function fetchFromFallback() {
  const res = await fetch(FALLBACK_API_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`Fallback rate fetch failed (${res.status})`);
  const data = await res.json();

  if (typeof data?.rates?.EUR !== "number") {
    throw new Error("Unexpected fallback rate response");
  }

  return {
    rate: data.rates.EUR,
    fetchedAt: Date.now(),
    apiTimeLastUpdateUtc: data.date ?? null
  };
}

/**
 * Returns a cached CAD→EUR rate if it is less than 24 hours old,
 * otherwise fetches a fresh rate (primary API → fallback API → stale cache).
 * @returns {Promise<{rate: number, fetchedAt: number, apiTimeLastUpdateUtc: string|null}>}
 */
async function getCachedOrFreshRate() {
  const { [STORAGE_KEY]: cache } = await chrome.storage.local.get(STORAGE_KEY);

  if (cache?.rate && cache?.fetchedAt && (Date.now() - cache.fetchedAt) < TTL_MS) {
    return cache;
  }

  try {
    const fresh = await fetchCadToEurRate();
    await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
    return fresh;
  } catch {
    try {
      const fresh = await fetchFromFallback();
      await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
      return fresh;
    } catch {
      // Fail-open: serve stale cache if it exists at all, rather than breaking conversion
      if (cache?.rate) return cache;
      throw new Error("All rate sources failed and no cached rate available");
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_CAD_EUR_RATE") return;

  getCachedOrFreshRate()
    .then((cache) => sendResponse({ ok: true, ...cache }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keep message channel open for async sendResponse
});
