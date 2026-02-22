const VAT_KEY         = "vatPercent";
const RATE_KEY        = "cadEurRateCache";
const COUNTRY_KEY     = "vatCountry";
const VAT_DEFAULT     = 20;
const TOAST_DURATION_MS = 1800;

// Standard VAT rates for EU/EEA countries. "Custom" means user-typed value.
const COUNTRY_VAT_PRESETS = [
  { label: "Custom",                    rate: null },
  { label: "Austria (AT) — 20%",        rate: 20   },
  { label: "Belgium (BE) — 21%",        rate: 21   },
  { label: "Denmark (DK) — 25%",        rate: 25   },
  { label: "Finland (FI) — 25.5%",      rate: 25.5 },
  { label: "France (FR) — 20%",         rate: 20   },
  { label: "Germany (DE) — 19%",        rate: 19   },
  { label: "Ireland (IE) — 23%",        rate: 23   },
  { label: "Italy (IT) — 22%",          rate: 22   },
  { label: "Netherlands (NL) — 21%",    rate: 21   },
  { label: "Norway (NO) — 25%",         rate: 25   },
  { label: "Poland (PL) — 23%",         rate: 23   },
  { label: "Portugal (PT) — 23%",       rate: 23   },
  { label: "Spain (ES) — 21%",          rate: 21   },
  { label: "Sweden (SE) — 25%",         rate: 25   },
  { label: "Switzerland (CH) — 8.1%",   rate: 8.1  },
];

const vatInput      = document.getElementById("vatInput");
const saveBtn       = document.getElementById("save");
const rateDisplay   = document.getElementById("rateDisplay");
const previewEur    = document.getElementById("previewEur");
const cacheAgeEl    = document.getElementById("cacheAge");
const toast         = document.getElementById("toast");
const countrySelect = document.getElementById("countrySelect");
const refreshBtn    = document.getElementById("refreshRate");

let currentRate = null;

// ── Populate country select ───────────────────────────────────────────────────
COUNTRY_VAT_PRESETS.forEach(({ label }, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = label;
  countrySelect.appendChild(opt);
});

// ── Load saved VAT & rate on open ────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get([VAT_KEY, RATE_KEY, COUNTRY_KEY]);

  // Restore selected country preset
  const savedCountry = typeof data[COUNTRY_KEY] === "number" ? data[COUNTRY_KEY] : 0;
  countrySelect.value = savedCountry;

  // VAT
  const savedVat = typeof data[VAT_KEY] === "number" ? data[VAT_KEY] : VAT_DEFAULT;
  vatInput.value = savedVat;

  // Rate
  const cache = data[RATE_KEY];
  if (cache?.rate) {
    currentRate = cache.rate;
    rateDisplay.textContent = currentRate.toFixed(6);
    rateDisplay.classList.remove("loading");

    if (cache.fetchedAt) {
      const ageMin = Math.round((Date.now() - cache.fetchedAt) / 60_000);
      cacheAgeEl.textContent = ageMin < 2 ? "rate: just now" : `rate: ${ageMin}m ago`;
    }
  } else {
    // Trigger a fresh fetch via background
    try {
      const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_EUR_RATE" });
      if (resp?.ok && resp.rate) {
        currentRate = resp.rate;
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

  updatePreview();
}

// ── Live preview while typing ─────────────────────────────────────────────────
function updatePreview() {
  const pct = parseFloat(vatInput.value);
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    previewEur.textContent = "—";
    return;
  }

  const multiplier = 1 + pct / 100;

  if (currentRate) {
    const eur = 100 * currentRate * multiplier;
    previewEur.textContent = `€ ${eur.toFixed(2)}`;
  } else {
    // Show multiplier effect only, no live rate yet
    previewEur.textContent = `×${multiplier.toFixed(3)}`;
  }
}

vatInput.addEventListener("input", () => {
  // If user edits the number manually, revert preset to "Custom"
  countrySelect.value = 0;
  updatePreview();
});

// ── Country preset selection ──────────────────────────────────────────────────
countrySelect.addEventListener("change", () => {
  const idx = parseInt(countrySelect.value, 10);
  const preset = COUNTRY_VAT_PRESETS[idx];
  if (preset?.rate !== null && preset?.rate !== undefined) {
    vatInput.value = preset.rate;
    updatePreview();
  }
  // "Custom" (idx 0) leaves vatInput unchanged
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
    const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_EUR_RATE" });
    if (resp?.ok && resp.rate) {
      currentRate = resp.rate;
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
  await chrome.storage.local.set({ [VAT_KEY]: pct, [COUNTRY_KEY]: countryIdx });

  // Notify any active content scripts to re-run immediately
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: "VAT_UPDATED", vatPercent: pct }).catch(() => {
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
