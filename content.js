const VAT_KEY = "vatPercent";
const VAT_DEFAULT_PERCENT = 20;

// On checkout pages all prices are converted straight (CAD × rate) with no VAT
// multiplier.  VAT / taxes are already shown as a separate line by Shopify, so
// adding them again would double-count them.

const SUFFIX_CLASS = "kesch-eur-suffix";
// Matches any currency suffix "(€ 12,34)" / "(£12.34)" appended by this extension.
const SUFFIX_RE = /\s*\([^)]{1,40}\)\s*$/;

const TARGET_CURRENCY_KEY     = "targetCurrency";
const TARGET_CURRENCY_DEFAULT = "EUR";
const INCLUDE_VAT_KEY         = "includeVat";

// Dollar-symbol currencies: use currency code in display to avoid confusion
// with the source CAD "$" already shown on the store pages.
const DOLLAR_CURRENCY_CODES = new Set(["USD", "AUD", "NZD", "SGD", "HKD", "MXN"]);

// ── Named constants ───────────────────────────────────────────────────────────
const DEBOUNCE_DELAY_MS = 200;  // wait for DOM to settle before re-scanning

function formatCurrency(value, currency) {
  const currencyDisplay = DOLLAR_CURRENCY_CODES.has(currency) ? "code" : "narrowSymbol";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay,
  }).format(value);
}

// ── Dynamic VAT ───────────────────────────────────────────────────────────────
// Reads the user-configured VAT percentage from storage and returns it as a
// multiplier (e.g. 20% → 1.20). Falls back to 20% if nothing is stored yet.
async function getVatMultiplier() {
  const data = await chrome.storage.local.get([VAT_KEY, INCLUDE_VAT_KEY]);
  if (data[INCLUDE_VAT_KEY] === false) return 1;
  const pct = typeof data[VAT_KEY] === "number" ? data[VAT_KEY] : VAT_DEFAULT_PERCENT;
  return 1 + pct / 100;
}

// Returns the raw VAT percentage regardless of the includeVat toggle.
// Used for notices that are always shown (checkout, cart).
async function getVatPercent() {
  const data = await chrome.storage.local.get(VAT_KEY);
  return typeof data[VAT_KEY] === "number" ? data[VAT_KEY] : VAT_DEFAULT_PERCENT;
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

async function getTargetCurrency() {
  const data = await chrome.storage.local.get(TARGET_CURRENCY_KEY);
  return typeof data[TARGET_CURRENCY_KEY] === "string"
    ? data[TARGET_CURRENCY_KEY]
    : TARGET_CURRENCY_DEFAULT;
}

// ── Background communication ──────────────────────────────────────────────────
async function getRatesFromBackground() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_RATES" });
  if (!resp?.ok) throw new Error(resp?.error || "Rates unavailable");
  return resp.rates;  // full { EUR: 0.728, GBP: 0.621, … } object
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function upsertSuffixInside(el, suffixText) {
  if (el.childElementCount === 0) {
    const raw  = (el.textContent || "");
    const base = raw.replace(SUFFIX_RE, "");
    if (raw !== base) el.textContent = base;
  }

  let s = el.querySelector(`:scope > span.${SUFFIX_CLASS}`);
  if (!s) {
    s = document.createElement("span");
    s.className = SUFFIX_CLASS;
    s.style.whiteSpace = "nowrap";
    s.style.verticalAlign = "baseline";
    el.appendChild(s);
  }
  // Guard: only write if the text actually changed to avoid triggering
  // the MutationObserver on every update cycle (would cause infinite loop).
  if (s.textContent !== suffixText) s.textContent = suffixText;
}

function clearSuffixInside(el) {
  el.querySelectorAll(`:scope > span.${SUFFIX_CLASS}`).forEach((n) => n.remove());
}

// ── Loading indicator ─────────────────────────────────────────────────────────
let loadingIndicator = null;
const LOADING_CLASS    = "kesch-loading-indicator";
const TAX_NOTICE_CLASS = "kesch-tax-notice";

function showLoadingIndicator() {
  if (loadingIndicator) return;
  if (!document.getElementById("kesch-style")) {
    const style = document.createElement("style");
    style.id = "kesch-style";
    style.textContent = `.${LOADING_CLASS}{position:fixed;bottom:12px;right:12px;background:rgba(255,122,0,.85);color:#fff;font-size:11px;padding:4px 10px;border-radius:12px;z-index:999999;pointer-events:none;font-family:monospace}`;
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

// ── Tax-notice for checkout ────────────────────────────────────────────────────
// Shopify only shows "Estimated taxes" when the threshold is met. If the row
// is absent we inject a small note so the user isn't surprised at payment.
// When rate/vatPct/currency are provided, a VAT estimate is always appended
// regardless of the "include VAT in store" toggle.
function updateTaxNotice(rate, vatPct, currency) {
  const existing    = document.querySelector(`.${TAX_NOTICE_CLASS}`);
  const rowHeaders  = Array.from(document.querySelectorAll('[role="rowheader"]'));

  // If a tax/duties row already exists, make sure our notice is gone.
  const hasTaxRow = rowHeaders.some((el) =>
    /tax|duti|levies|impôt|steuer/i.test(el.textContent)
  );
  if (hasTaxRow) { existing?.remove(); return; }

  // Find the Total row and insert the notice after it.
  const totalHeader = rowHeaders.find((el) => /\btotal\b/i.test(el.textContent.trim()));
  if (!totalHeader) return;
  const totalRow = totalHeader.closest('[role="row"]');
  if (!totalRow) return;

  // Build an estimated VAT line when a VAT rate is configured and we have a rate.
  let vatLine = "";
  if (rate && vatPct > 0 && currency) {
    const priceCell = totalRow.querySelector('[role="cell"]');
    const cadAmount = priceCell ? parseAmountFromDollarText(priceCell.textContent || "") : null;
    if (cadAmount !== null) {
      const localAmount  = cadAmount * rate;
      const vatAmount    = localAmount * (vatPct / 100);
      const totalWithVat = localAmount + vatAmount;
      vatLine = `est. ~${vatPct}% VAT: ${formatCurrency(vatAmount, currency)} · total incl. taxes: ${formatCurrency(totalWithVat, currency)}`;
    }
  }

  const noticeText = `No taxes collected by LTTStore for this order.${vatLine ? `\n${vatLine}` : ""}`;

  if (existing) {
    // Update text if it changed (avoids triggering the MutationObserver loop).
    if (existing.textContent !== noticeText) existing.textContent = noticeText;
    return;
  }

  const notice = document.createElement("p");
  notice.className = TAX_NOTICE_CLASS;
  notice.textContent = noticeText;
  notice.style.cssText =
    "font-size:11px;opacity:0.55;text-align:right;padding:6px 0 0;margin:0;font-family:inherit;white-space:pre-line";
  totalRow.insertAdjacentElement("afterend", notice);
}

// ── Converters ────────────────────────────────────────────────────────────────
function convertStorePriceItem(el, rate, vatMultiplier, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("CAD") || !raw.includes("$")) return;

  const base = raw.replace(SUFFIX_RE, "").trim();
  const cad  = parseAmountFromDollarText(base);
  if (cad === null) return;

  const next = `${base} (${formatCurrency(cad * rate * vatMultiplier, currency)})`;
  if (raw !== next) el.textContent = next;
}

function convertCartPrice(el, rate, vatMultiplier, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  upsertSuffixInside(el, ` (${formatCurrency(cad * rate * vatMultiplier, currency)})`);
}

function convertCheckout(el, rate, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  // Straight CAD→local currency; no VAT added — taxes are already shown as a
  // separate line by Shopify, so adding VAT here would double-count them.
  upsertSuffixInside(el, ` (${formatCurrency(cad * rate, currency)})`);
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
let scheduled     = false;
let running       = false;
let pendingUpdate = false;

async function updateAll() {
  if (!isLikelyLttContext()) return;

  const kind = pageKind();
  if (kind === "other") return;

  if (running) { pendingUpdate = true; return; }
  running       = true;
  pendingUpdate = false;

  showLoadingIndicator();

  try {
    // Fetch rates, VAT multiplier, raw VAT %, and target currency in parallel
    const [rates, vatMultiplier, currency, vatPct] = await Promise.all([
      getRatesFromBackground(),
      getVatMultiplier(),
      getTargetCurrency(),
      getVatPercent(),
    ]);

    const rate = rates[currency];
    if (typeof rate !== "number") throw new Error(`No rate available for ${currency}`);

    const targets = findTargets(kind);

    if (kind === "store") {
      targets.forEach((n) => convertStorePriceItem(n, rate, vatMultiplier, currency));
    } else if (kind === "cart") {
      targets.forEach((n) => convertCartPrice(n, rate, vatMultiplier, currency));
    } else if (kind === "checkout") {
      targets.forEach((n) => convertCheckout(n, rate, currency));
      updateTaxNotice(rate, vatPct, currency);
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
function attachObserver() {
  const kind = pageKind();
  // Always observe document.body (not just <main>) so mutations anywhere in
  // the page layout are caught — on the Shopify checkout the order-summary
  // sidebar lives outside <main>, so narrowing to <main> causes us to miss
  // every price update triggered by a country / shipping change.
  const target = document.body || document.documentElement;
  obs.observe(target, {
    subtree:       true,
    childList:     true,
    // Enable characterData on all relevant pages: Shopify/React updates price
    // text nodes in-place (textNode.nodeValue change = characterData mutation).
    characterData: kind !== "other",
  });
}

const obs = new MutationObserver((mutations) => {
  // Ignore mutations caused by our own injected nodes so we don't re-trigger
  // ourselves in an infinite loop.
  const selfMutation = mutations.every((m) => {
    // Loading indicator
    if (m.target === loadingIndicator ||
        (m.target instanceof Element && m.target.classList.contains(LOADING_CLASS))) return true;
    // Suffix span itself had a child added/removed (e.g. first textContent set)
    if (m.target instanceof Element && m.target.classList.contains(SUFFIX_CLASS)) return true;
    // Text node inside a suffix span or tax-notice changed value (characterData mutation)
    if (m.type === "characterData" &&
        (m.target.parentElement?.classList.contains(SUFFIX_CLASS) ||
         m.target.parentElement?.classList.contains(TAX_NOTICE_CLASS))) return true;
    // childList: the only added/removed nodes are our own suffix/loading spans
    if (m.type === "childList") {
      const nodes = [...m.addedNodes, ...m.removedNodes];
      if (nodes.length > 0 && nodes.every((n) =>
        n instanceof Element &&
        (n.classList.contains(SUFFIX_CLASS) ||
         n.classList.contains(LOADING_CLASS) ||
         n.classList.contains(TAX_NOTICE_CLASS))
      )) return true;
    }
    return false;
  });
  if (selfMutation) return;
  scheduleUpdate();
});

attachObserver();
window.addEventListener("popstate", () => {
  scheduleUpdate();
});

// Node.js export guard for unit testing (no-op in Chrome extension context)
if (typeof module !== "undefined") {
  module.exports = { parseAmountFromDollarText };
}
