const VAT_KEY              = "vatPercent";
const RATE_KEY             = "cadRateCache";
const COUNTRY_KEY          = "vatCountry";
const TARGET_CURRENCY_KEY  = "targetCurrency";
const CONFIGURED_KEY       = "isConfigured";
const INCLUDE_VAT_KEY      = "includeVat";
const TARGET_CURRENCY_DEFAULT = "EUR";
const VAT_DEFAULT          = 20;
const TOAST_DURATION_MS    = 1800;

// Dollar-symbol currencies: displayed with currency code to avoid confusion
// with the source CAD "$" shown on the store pages.
const DOLLAR_CURRENCY_CODES = new Set(["USD", "AUD", "NZD", "SGD", "HKD", "MXN"]);

function formatCurrency(value, currency) {
  const currencyDisplay = DOLLAR_CURRENCY_CODES.has(currency) ? "code" : "narrowSymbol";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay,
  }).format(value);
}

// Country presets: each drives both the display currency and the VAT rate.
// Sorted A-Z; Custom is always first.
const COUNTRIES = [
  { name: "Custom" },
  { name: "Australia",      currency: "AUD", vat: 10   },
  { name: "Austria",        currency: "EUR", vat: 20   },
  { name: "Belgium",        currency: "EUR", vat: 21   },
  { name: "Czech Republic", currency: "CZK", vat: 21   },
  { name: "Denmark",        currency: "DKK", vat: 25   },
  { name: "Finland",        currency: "EUR", vat: 25.5 },
  { name: "France",         currency: "EUR", vat: 20   },
  { name: "Germany",        currency: "EUR", vat: 19   },
  { name: "Hungary",        currency: "HUF", vat: 27   },
  { name: "Ireland",        currency: "EUR", vat: 23   },
  { name: "Italy",          currency: "EUR", vat: 22   },
  { name: "Japan",          currency: "JPY", vat: 10   },
  { name: "Mexico",         currency: "MXN", vat: 16   },
  { name: "Netherlands",    currency: "EUR", vat: 21   },
  { name: "New Zealand",    currency: "NZD", vat: 15   },
  { name: "Norway",         currency: "NOK", vat: 25   },
  { name: "Poland",         currency: "PLN", vat: 23   },
  { name: "Portugal",       currency: "EUR", vat: 23   },
  { name: "Romania",        currency: "RON", vat: 19   },
  { name: "Singapore",      currency: "SGD", vat: 9    },
  { name: "South Korea",    currency: "KRW", vat: 10   },
  { name: "Spain",          currency: "EUR", vat: 21   },
  { name: "Sweden",         currency: "SEK", vat: 25   },
  { name: "Switzerland",    currency: "CHF", vat: 8.1  },
  { name: "United Kingdom", currency: "GBP", vat: 20   },
  { name: "United States",  currency: "USD", vat: 0    },
];

const vatInput          = document.getElementById("vatInput");
const saveBtn           = document.getElementById("save");
const rateDisplay       = document.getElementById("rateDisplay");
const rateCurrencyLabel = document.getElementById("rateCurrencyLabel");
const previewEur        = document.getElementById("previewEur");
const cacheAgeEl        = document.getElementById("cacheAge");
const toast             = document.getElementById("toast");
const countrySelect      = document.getElementById("countrySelect");
const currencySelect     = document.getElementById("currencySelect");
const includeVatToggle   = document.getElementById("includeVatToggle");
const refreshBtn         = document.getElementById("refreshRate");

function setCurrencySelectEnabled(enabled) {
  currencySelect.disabled = !enabled;
}

// ── Currency name helper ──────────────────────────────────────────────────────
const _currencyNames = new Intl.DisplayNames(["en"], { type: "currency" });

// Populate currency select from a rates object (keys are ISO 4217 codes).
// Currencies with no known display name (e.g. "FOK", "GGB") are skipped.
// Falls back to the currencies in COUNTRIES if rates aren't available yet.
function populateCurrencySelect(rates, selectedCurrency) {
  const codes = rates
    ? Object.keys(rates).sort()
    : [...new Set(COUNTRIES.map((c) => c.currency).filter(Boolean))].sort();

  currencySelect.innerHTML = "";
  codes.forEach((code) => {
    let name;
    try { name = _currencyNames.of(code); } catch { return; }
    if (!name || name === code) return; // skip unknown / pseudo-currencies
    const opt = document.createElement("option");
    opt.value       = code;
    opt.textContent = `${code} (${name})`;
    currencySelect.appendChild(opt);
  });
  currencySelect.value = selectedCurrency;
}

let currentRate     = null;
let currentCurrency = TARGET_CURRENCY_DEFAULT;

// ── Populate country select ───────────────────────────────────────────────────
COUNTRIES.forEach(({ name, currency, vat }, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = currency ? `${name} — ${currency} — ${vat}%` : name;
  countrySelect.appendChild(opt);
});

// ── Load saved settings & rate on open ───────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get([VAT_KEY, RATE_KEY, COUNTRY_KEY, TARGET_CURRENCY_KEY, CONFIGURED_KEY, INCLUDE_VAT_KEY]);

  // First-install detection: no settings saved yet
  const isFirstRun = data[CONFIGURED_KEY] !== true;
  const setupHint  = document.getElementById("setupHint");
  if (setupHint) setupHint.hidden = !isFirstRun;

  // Restore selected country preset
  const savedCountry = typeof data[COUNTRY_KEY] === "number" ? data[COUNTRY_KEY] : 0;
  countrySelect.value = savedCountry;

  // Derive current currency: prefer the preset's currency (most reliable),
  // fall back to the stored target currency, then the global default.
  currentCurrency =
    COUNTRIES[savedCountry]?.currency ||
    (typeof data[TARGET_CURRENCY_KEY] === "string" ? data[TARGET_CURRENCY_KEY] : null) ||
    TARGET_CURRENCY_DEFAULT;
  rateCurrencyLabel.textContent = currentCurrency;

  // VAT
  const savedVat = typeof data[VAT_KEY] === "number" ? data[VAT_KEY] : VAT_DEFAULT;
  vatInput.value = savedVat;
  includeVatToggle.checked = data[INCLUDE_VAT_KEY] !== false; // default true

  // Rate: try cache first, then ask background
  const cache = data[RATE_KEY];
  let allRates = null;
  if (cache?.rates?.[currentCurrency]) {
    allRates    = cache.rates;
    currentRate = cache.rates[currentCurrency];
    rateDisplay.textContent = currentRate.toFixed(6);
    rateDisplay.classList.remove("loading");
    if (cache.fetchedAt) {
      const ageMin = Math.round((Date.now() - cache.fetchedAt) / 60_000);
      cacheAgeEl.textContent = ageMin < 2 ? "rate: just now" : `rate: ${ageMin}m ago`;
    }
  } else {
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_RATES" });
      if (resp?.ok && resp.rates?.[currentCurrency]) {
        allRates    = resp.rates;
        currentRate = resp.rates[currentCurrency];
        rateDisplay.textContent = currentRate.toFixed(6);
        rateDisplay.classList.remove("loading");
        cacheAgeEl.textContent = "rate: just now";
      } else {
        rateDisplay.textContent = "unavailable";
      }
    } catch {
      rateDisplay.textContent = "unavailable";
    }
  }

  // Populate currency select from full rate list (or preset fallback)
  populateCurrencySelect(allRates, currentCurrency);
  // Custom (index 0) → editable; any preset → locked to its currency
  setCurrencySelectEnabled(savedCountry === 0);

  updatePreview();
}

// ── Live preview while typing ─────────────────────────────────────────────────
function updatePreview() {
  const pct = parseFloat(vatInput.value);
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    previewEur.textContent = "—";
    return;
  }

  const multiplier = includeVatToggle.checked ? 1 + pct / 100 : 1;

  if (currentRate !== null) {
    previewEur.textContent = formatCurrency(100 * currentRate * multiplier, currentCurrency);
  } else {
    // Show multiplier effect only, no live rate yet
    previewEur.textContent = `×${multiplier.toFixed(3)}`;
  }
}

vatInput.addEventListener("input", () => {
  // If user edits the number manually, revert preset to "Custom"
  countrySelect.value = 0;
  setCurrencySelectEnabled(true);
  updatePreview();
});

includeVatToggle.addEventListener("change", updatePreview);

// ── Country preset selection ──────────────────────────────────────────────────
countrySelect.addEventListener("change", () => {
  const idx    = parseInt(countrySelect.value, 10);
  const preset = COUNTRIES[idx];

  if (preset?.vat !== undefined) vatInput.value = preset.vat;

  if (preset?.currency) {
    // Preset chosen: lock currency select to preset's currency
    currentCurrency = preset.currency;
    currencySelect.value = currentCurrency;
    setCurrencySelectEnabled(false);
    rateCurrencyLabel.textContent = currentCurrency;

    // Pick rate for the newly selected currency from the cached rates object
    chrome.storage.local.get(RATE_KEY).then(({ [RATE_KEY]: cache }) => {
      if (cache?.rates?.[currentCurrency]) {
        currentRate = cache.rates[currentCurrency];
        rateDisplay.textContent = currentRate.toFixed(6);
        rateDisplay.classList.remove("loading");
      } else {
        currentRate = null;
        rateDisplay.textContent = "unavailable";
      }
      updatePreview();
    });
  } else {
    // "Custom" — unlock currency select so user can freely change it
    setCurrencySelectEnabled(true);
    updatePreview();
  }
});

// ── Currency select (active only in Custom mode) ──────────────────────────────
currencySelect.addEventListener("change", () => {
  currentCurrency = currencySelect.value;
  rateCurrencyLabel.textContent = currentCurrency;

  chrome.storage.local.get(RATE_KEY).then(({ [RATE_KEY]: cache }) => {
    if (cache?.rates?.[currentCurrency]) {
      currentRate = cache.rates[currentCurrency];
      rateDisplay.textContent = currentRate.toFixed(6);
      rateDisplay.classList.remove("loading");
    } else {
      currentRate = null;
      rateDisplay.textContent = "unavailable";
    }
    updatePreview();
  });
});

// ── Manual rate refresh ───────────────────────────────────────────────────────
async function refreshRate() {
  refreshBtn.disabled = true;
  rateDisplay.textContent = "loading…";
  rateDisplay.classList.add("loading");
  cacheAgeEl.textContent = "";

  // Clear the cached entry so the background worker fetches fresh data
  await chrome.storage.local.remove(RATE_KEY);

  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_RATES" });
    if (resp?.ok && resp.rates?.[currentCurrency]) {
      currentRate = resp.rates[currentCurrency];
      rateDisplay.textContent = currentRate.toFixed(6);
      rateDisplay.classList.remove("loading");
      cacheAgeEl.textContent = "rate: just now";
    } else {
      rateDisplay.textContent = "unavailable";
    }
  } catch {
    rateDisplay.textContent = "unavailable";
  } finally {
    refreshBtn.disabled = false;
  }

  updatePreview();
}

refreshBtn.addEventListener("click", refreshRate);

// ── Save ──────────────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", async () => {
  const pct = parseFloat(vatInput.value);
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    vatInput.focus();
    return;
  }

  const countryIdx = parseInt(countrySelect.value, 10);

  saveBtn.disabled = true;
  await chrome.storage.local.set({
    [VAT_KEY]:            pct,
    [COUNTRY_KEY]:        countryIdx,
    [TARGET_CURRENCY_KEY]: currentCurrency,
    [INCLUDE_VAT_KEY]:    includeVatToggle.checked,
    [CONFIGURED_KEY]:     true,
  });

  // Hide first-run hint once the user has saved settings
  const setupHint = document.getElementById("setupHint");
  if (setupHint) setupHint.hidden = true;

  // Notify any active content scripts to re-run immediately
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "VAT_UPDATED" }).catch(() => {
      // Tab might not have content.js (e.g. not on lttstore) – ignore
    });
  }

  showToast();
  saveBtn.disabled = false;
});

// Allow Enter key to save
vatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast() {
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), TOAST_DURATION_MS);
}

init();
