const VAT_KEY = "vatPercent";
const VAT_DEFAULT_PERCENT = 20;

// VAT_MULTIPLIER_CHECKOUT stays 1.00 (checkout = conversion only, no VAT added here;
// VAT will be collected by the buyer's country at import / by Shopify during checkout).
const VAT_MULTIPLIER_CHECKOUT = 1.00;

const SUFFIX_CLASS = "kesch-eur-suffix";
// Matches "(€ 12,34)" already appended by older versions (tolerates spacing).
const EUR_SUFFIX_RE = /\s*\(\s*€\s*[\d.,]+?\s*\)\s*$/;

// ── Named constants ───────────────────────────────────────────────────────────
const DEBOUNCE_DELAY_MS       = 200;  // wait for DOM to settle before re-scanning
const CHECKOUT_RETRY_DELAY_MS = 600;  // extra wait for Shopify to inject the tax row
const CHECKOUT_MAX_RETRIES    = 3;    // max re-scans before accepting missing tax data

const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatEur(value) {
  return `€ ${EUR_FORMATTER.format(value)}`;
}

// ── Dynamic VAT ───────────────────────────────────────────────────────────────
// Reads the user-configured VAT percentage from storage and returns it as a
// multiplier (e.g. 20% → 1.20). Falls back to 20% if nothing is stored yet.
async function getVatMultiplier() {
  const data = await chrome.storage.local.get(VAT_KEY);
  const pct = typeof data[VAT_KEY] === "number" ? data[VAT_KEY] : VAT_DEFAULT_PERCENT;
  return 1 + pct / 100;
}

// ── Page detection ────────────────────────────────────────────────────────────
function pageKind() {
  const host = location.hostname;
  const path = location.pathname || "";
  if (host === "global.lttstore.com" && path.startsWith("/cart")) return "cart";
  if (path.includes("/checkouts/") || path.startsWith("/checkout") || host.includes("checkout.")) return "checkout";
  if (host === "global.lttstore.com") return "store";
  return "other";
}

function isLikelyLttContext() {
  const host = location.hostname;
  if (host === "global.lttstore.com") return true;

  const title = (document.title || "").toLowerCase();
  if (title.includes("lttstore")) return true;

  const ogSite = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "";
  if (ogSite.toLowerCase().includes("lttstore")) return true;

  return false;
}

// ── Number parsing ────────────────────────────────────────────────────────────
/**
 * Extracts a numeric CAD dollar amount from a raw text string.
 * Handles US format ($1,234.56), EU format ($1.234,56),
 * and NBSP-separated variants ($ 99,99). Returns null if no parseable amount found.
 * @param {string} text - Raw text content, e.g. "$39.99 CAD"
 * @returns {number|null}
 */
function parseAmountFromDollarText(text) {
  // Supports "$39.99 CAD", "$99.99", "$ 99,99" (NBSP + comma decimals)
  const t = String(text || "").replace(/\u00A0/g, " ");
  const m = t.match(/\$\s*([0-9][0-9\s.,]*)/);
  if (!m) return null;

  let num = m[1].replace(/\s/g, "");
  num = num.replace(/[.,]+$/, "");

  const hasDot   = num.includes(".");
  const hasComma = num.includes(",");

  if (hasDot && hasComma) {
    if (num.lastIndexOf(",") > num.lastIndexOf(".")) {
      num = num.replace(/\./g, "").replace(",", ".");
    } else {
      num = num.replace(/,/g, "");
    }
  } else if (hasComma) {
    const frac = num.length - num.lastIndexOf(",") - 1;
    if (frac === 1 || frac === 2) num = num.replace(/\./g, "").replace(",", ".");
    else num = num.replace(/,/g, "");
  } else if (hasDot) {
    const frac = num.length - num.lastIndexOf(".") - 1;
    if (frac === 1 || frac === 2) num = num.replace(/,/g, "");
    else num = num.replace(/\./g, "");
  }

  const val = Number.parseFloat(num);
  return Number.isFinite(val) ? val : null;
}

// ── Background communication ──────────────────────────────────────────────────
async function getRateFromBackground() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_EUR_RATE" });
  if (!resp?.ok) throw new Error(resp?.error || "Rate unavailable");
  return resp.rate;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function upsertSuffixInside(el, suffixText) {
  if (el.childElementCount === 0) {
    const raw  = (el.textContent || "");
    const base = raw.replace(EUR_SUFFIX_RE, "");
    if (raw !== base) el.textContent = base;
  }

  let s = el.querySelector(`:scope > span.${SUFFIX_CLASS}`);
  if (!s) {
    s = document.createElement("span");
    s.className = SUFFIX_CLASS;
    s.style.whiteSpace = "nowrap";
    el.appendChild(s);
  }
  s.textContent = suffixText;
}

function clearSuffixInside(el) {
  el.querySelectorAll(`:scope > span.${SUFFIX_CLASS}`).forEach((n) => n.remove());
}

// ── Loading indicator ─────────────────────────────────────────────────────────
let loadingIndicator = null;
const LOADING_CLASS  = "kesch-loading-indicator";

function showLoadingIndicator() {
  if (loadingIndicator) return;
  if (!document.getElementById("kesch-style")) {
    const style = document.createElement("style");
    style.id = "kesch-style";
    style.textContent = `.${LOADING_CLASS}{position:fixed;bottom:12px;right:12px;background:rgba(79,138,255,.85);color:#fff;font-size:11px;padding:4px 10px;border-radius:12px;z-index:999999;pointer-events:none;font-family:monospace}`;
    document.head?.appendChild(style);
  }
  loadingIndicator = document.createElement("div");
  loadingIndicator.className = LOADING_CLASS;
  loadingIndicator.textContent = "€ …";
  document.body?.appendChild(loadingIndicator);
}

function hideLoadingIndicator() {
  loadingIndicator?.remove();
  loadingIndicator = null;
}

// ── Converters ────────────────────────────────────────────────────────────────
function convertStorePriceItem(el, rate, vatMultiplier) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("CAD") || !raw.includes("$")) return;

  const base = raw.replace(EUR_SUFFIX_RE, "").trim();
  const cad  = parseAmountFromDollarText(base);
  if (cad === null) return;

  const eurGross = cad * rate * vatMultiplier;
  const next     = `${base} (${formatEur(eurGross)})`;
  if (raw !== next) el.textContent = next;
}

function convertCartPrice(el, rate, vatMultiplier) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  const eurGross = cad * rate * vatMultiplier;
  upsertSuffixInside(el, ` (${formatEur(eurGross)})`);
}

function isEstimatedTaxesRow(el) {
  // Intentionally exclude bare 'div': .closest("div") always matches and
  // its textContent can span the whole page.
  const row = el.closest("[role='row'], tr, li");
  const t   = (row?.textContent || "").toLowerCase();
  return (t.includes("tax") || t.includes("steuern") || t.includes("steuer"))
    && !t.includes("total");
}

/**
 * Scans the Shopify checkout DOM for the grand total element and any estimated
 * tax rows. The tax amount is subtracted before converting because VAT will be
 * collected by the buyer's country at import (not applied here).
 * @param {Document|Element} root
 * @returns {{ totalNode: Element|null, totalVal: number|null, taxVal: number|null }}
 */
function findCheckoutTotalsAndTaxes(root) {
  // Only query inline/leaf nodes – block containers like <div> accumulate all
  // child text in textContent, making substring checks unreliable.
  const allDollarNodes = Array.from(root.querySelectorAll("strong, span"))
    .filter((n) => (n.textContent || "").includes("$"));

  let totalNode = null;
  let totalVal  = null;

  for (const n of allDollarNodes) {
    const row = n.closest("[role='row'], tr, li");
    if (!row) continue;
    const rowText = (row.textContent || "").toLowerCase();
    if (rowText.includes("total") && !rowText.includes("subtotal")) {
      const v = parseAmountFromDollarText(n.textContent || "");
      if (typeof v === "number" && (totalVal === null || v > totalVal)) {
        totalNode = n;
        totalVal  = v;
      }
    }
  }

  // Fallback: highest <strong> value (flat-HTML checkouts)
  if (!totalNode) {
    const parsed = allDollarNodes
      .filter((n) => n.tagName === "STRONG")
      .map((n) => ({ n, v: parseAmountFromDollarText(n.textContent || "") }))
      .filter((x) => typeof x.v === "number");
    if (parsed.length) {
      parsed.sort((a, b) => b.v - a.v);
      totalNode = parsed[0].n;
      totalVal  = parsed[0].v;
    }
  }

  const taxCandidates = Array.from(root.querySelectorAll("span, strong"))
    .filter((n) => (n.textContent || "").includes("$") && isEstimatedTaxesRow(n))
    .map((n) => parseAmountFromDollarText(n.textContent || ""))
    .filter((v) => typeof v === "number");

  return {
    totalNode,
    totalVal,
    taxVal: taxCandidates.length ? Math.max(...taxCandidates) : null,
  };
}

function convertCheckout(el, rate, ctx) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }
  if (isEstimatedTaxesRow(el)) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  if (ctx?.totalNode && el === ctx.totalNode
      && typeof ctx.totalVal === "number" && typeof ctx.taxVal === "number") {
    const netCad = Math.max(0, ctx.totalVal - ctx.taxVal);
    upsertSuffixInside(el, ` (${formatEur(netCad * rate * VAT_MULTIPLIER_CHECKOUT)})`);
    return;
  }

  upsertSuffixInside(el, ` (${formatEur(cad * rate * VAT_MULTIPLIER_CHECKOUT)})`);
}

// ── Target finding ────────────────────────────────────────────────────────────
function findTargets(kind, root = document) {
  if (kind === "store") {
    return Array.from(root.querySelectorAll(".price-item"))
      .filter((n) => (n.textContent || "").includes("$") && (n.textContent || "").includes("CAD"));
  }

  if (kind === "cart") {
    // Fast path: try known specific selectors first
    const CART_SELECTORS = [
      ".price.price--center.th_item_line_price",
      ".price--center.th_item_line_price",
      ".th_item_line_price .price",
      "span.price",
      "p.totals__subtotal-value.th_cart_total_price",
      ".totals__subtotal-value",
      ".th_cart_total_price",
    ];
    const out = new Set();
    for (const sel of CART_SELECTORS) {
      root.querySelectorAll(sel).forEach((n) => {
        if ((n.textContent || "").includes("$")) out.add(n);
      });
    }

    // Structural fallback: anchor to cart container and scan for price-like leaf nodes.
    // Activates when the LTT Store theme changes and the selector list returns nothing.
    if (out.size === 0) {
      const cartRoot = root.querySelector(
        'form[action="/cart"], [data-section-type="cart"], #cart, main'
      ) || root;
      cartRoot.querySelectorAll("span, p, div").forEach((n) => {
        const t = n.textContent || "";
        if (!t.includes("$")) return;
        if (n.children.length > 2) return; // skip large container nodes
        if (parseAmountFromDollarText(t) !== null) out.add(n);
      });
    }

    return Array.from(out);
  }

  if (kind === "checkout") {
    const selectors = [
      "[translate='no'].notranslate",
      ".notranslate[translate='no']",
      "strong.notranslate",
      "strong[translate='no']",
      "[role='cell'] span",
      "[role='cell'] strong",
    ];
    const out = new Set();
    for (const sel of selectors) {
      root.querySelectorAll(sel).forEach((n) => {
        if ((n.textContent || "").includes("$")) out.add(n);
      });
    }
    root.querySelectorAll("span, strong").forEach((n) => {
      const t = n.textContent || "";
      if (t.includes("$") && /[0-9]/.test(t)) out.add(n);
    });
    return Array.from(out);
  }

  return [];
}

// ── Main update loop ──────────────────────────────────────────────────────────
let scheduled      = false;
let running        = false;
let pendingUpdate  = false;
let checkoutRetryCount = 0;

async function updateAll() {
  if (!isLikelyLttContext()) return;

  const kind = pageKind();
  if (kind === "other") return;

  if (running) { pendingUpdate = true; return; }
  running       = true;
  pendingUpdate = false;

  showLoadingIndicator();

  try {
    // Fetch rate and VAT multiplier in parallel
    const [rate, vatMultiplier] = await Promise.all([
      getRateFromBackground(),
      getVatMultiplier(),
    ]);

    const targets = findTargets(kind);

    if (kind === "store") {
      targets.forEach((n) => convertStorePriceItem(n, rate, vatMultiplier));
    } else if (kind === "cart") {
      targets.forEach((n) => convertCartPrice(n, rate, vatMultiplier));
    } else if (kind === "checkout") {
      const ctx = findCheckoutTotalsAndTaxes(document);

      // If Shopify hasn't injected the tax row yet, wait and retry rather than
      // writing a wrong suffix (the race condition documented in the README).
      if (ctx.totalNode && ctx.taxVal === null && checkoutRetryCount < CHECKOUT_MAX_RETRIES) {
        checkoutRetryCount++;
        setTimeout(() => { scheduled = false; updateAll(); }, CHECKOUT_RETRY_DELAY_MS);
        return;
      }
      checkoutRetryCount = 0;
      targets.forEach((n) => convertCheckout(n, rate, ctx));
    }
  } catch (err) {
    console.debug("[LTTStore EUR]", err);
  } finally {
    running = false;
    hideLoadingIndicator();
    if (pendingUpdate) scheduleUpdate();
  }
}

function scheduleUpdate() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; updateAll(); }, DEBOUNCE_DELAY_MS);
}

// ── Message listener: VAT changed in popup → re-run immediately ───────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "VAT_UPDATED") scheduleUpdate();
});

// ── Boot ──────────────────────────────────────────────────────────────────────
scheduleUpdate();

// Observe the most specific stable ancestor available; fall back to documentElement.
// characterData is only needed on store pages (text nodes); cart/checkout use childList.
function attachObserver() {
  const kind = pageKind();
  const target = (
    document.querySelector("main") ||
    document.querySelector("#MainContent") ||
    document.body ||
    document.documentElement
  );
  obs.observe(target, {
    subtree:       true,
    childList:     true,
    characterData: kind === "store",
  });
}

const obs = new MutationObserver((mutations) => {
  // Ignore mutations caused by our own loading indicator to avoid re-triggering.
  const selfMutation = mutations.every((m) =>
    m.target === loadingIndicator ||
    (m.target instanceof Element && m.target.classList.contains(LOADING_CLASS))
  );
  if (selfMutation) return;
  scheduleUpdate();
});

attachObserver();
window.addEventListener("popstate", () => {
  checkoutRetryCount = 0;
  scheduleUpdate();
});

// Node.js export guard for unit testing (no-op in Chrome extension context)
if (typeof module !== "undefined") {
  module.exports = { parseAmountFromDollarText };
}
