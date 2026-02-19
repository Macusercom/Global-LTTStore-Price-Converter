const VAT_KEY    = "vatPercent";
const RATE_KEY   = "cadEurRateCache";
const VAT_DEFAULT = 20;

const vatInput     = document.getElementById("vatInput");
const saveBtn      = document.getElementById("save");
const rateDisplay  = document.getElementById("rateDisplay");
const previewEur   = document.getElementById("previewEur");
const cacheAgeEl   = document.getElementById("cacheAge");
const toast        = document.getElementById("toast");

let currentRate = null;

// ── Load saved VAT & rate on open ────────────────────────────────────────────
async function init() {
  const data = await chrome.storage.local.get([VAT_KEY, RATE_KEY]);

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

vatInput.addEventListener("input", updatePreview);

// ── Save ──────────────────────────────────────────────────────────────────────
saveBtn.addEventListener("click", async () => {
  const pct = parseFloat(vatInput.value);
  if (!isFinite(pct) || pct < 0 || pct > 100) {
    vatInput.focus();
    return;
  }

  saveBtn.disabled = true;
  await chrome.storage.local.set({ [VAT_KEY]: pct });

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
  setTimeout(() => toast.classList.remove("show"), 1800);
}

init();
