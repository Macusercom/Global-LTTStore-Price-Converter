const API_URL = "https://open.er-api.com/v6/latest/CAD";
const STORAGE_KEY = "cadEurRateCache";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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

async function getCachedOrFreshRate() {
  const { [STORAGE_KEY]: cache } = await chrome.storage.local.get(STORAGE_KEY);

  if (cache?.rate && cache?.fetchedAt && (Date.now() - cache.fetchedAt) < TTL_MS) {
    return cache;
  }

  const fresh = await fetchCadToEurRate();
  await chrome.storage.local.set({ [STORAGE_KEY]: fresh });
  return fresh;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "GET_CAD_EUR_RATE") return;

  getCachedOrFreshRate()
    .then((cache) => sendResponse({ ok: true, ...cache }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true; // keep message channel open for async sendResponse
});
