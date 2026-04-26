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
function upsertSuffixInside(el, suffixText, { block = false } = {}) {
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
  // block mode: let the suffix wrap to a new line below the base price.
  // Used in cart totals where the price lives in a tight justify-between
  // flex row that would otherwise clip the inline suffix.
  const desiredDisplay = block ? "block" : "";
  if (s.style.display !== desiredDisplay) s.style.display = desiredDisplay;
  // When the suffix wraps below, the right column grows taller than the
  // left "Subtotal/Total" label. The h-stack centers by default, which
  // makes the label float mid-row; pin it to the top instead so the label
  // lines up with the first line of the price.
  if (block) {
    const parent = el.parentElement;
    if (parent && parent.style.alignItems !== "flex-start") {
      parent.style.alignItems = "flex-start";
    }
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

function showLoadingIndicator(currency) {
  if (loadingIndicator) return;
  if (!document.getElementById("kesch-style")) {
    const style = document.createElement("style");
    style.id = "kesch-style";
    style.textContent = `.${LOADING_CLASS}{position:fixed;bottom:12px;right:12px;background:rgba(255,122,0,.85);color:#fff;font-size:11px;padding:4px 10px;border-radius:12px;z-index:999999;pointer-events:none;font-family:monospace}`;
    document.head?.appendChild(style);
  }
  loadingIndicator = document.createElement("div");
  loadingIndicator.className = LOADING_CLASS;
  try {
    const sym = currency
      ? new Intl.NumberFormat("en", { style: "currency", currency, currencyDisplay: DOLLAR_CURRENCY_CODES.has(currency) ? "code" : "narrowSymbol" })
          .formatToParts(0).find((p) => p.type === "currency")?.value ?? currency
      : "…";
    loadingIndicator.textContent = `${sym} …`;
  } catch {
    loadingIndicator.textContent = "…";
  }
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
      vatLine = `est. ${vatPct}% VAT: ~ ${formatCurrency(vatAmount, currency)} · total incl. taxes: ~ ${formatCurrency(totalWithVat, currency)}`;
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
    "font-size:11px;opacity:0.55;text-align:right;padding:6px 0 0;margin:0;font-family:inherit;white-space:pre-line;font-style:italic";
  totalRow.insertAdjacentElement("afterend", notice);
}

// ── Converters ────────────────────────────────────────────────────────────────
function convertStorePriceItem(el, rate, vatMultiplier, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("CAD") || !raw.includes("$")) return;

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  // Use upsertSuffixInside rather than overwriting textContent: the new
  // <sale-price> / <compare-at-price> wrappers contain an .sr-only child
  // ("Sale price") that a textContent rewrite would destroy.
  upsertSuffixInside(el, ` (~ ${formatCurrency(cad * rate * vatMultiplier, currency)})`);
}

function convertCartPrice(el, rate, vatMultiplier, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  // Cart totals (span.h5 / <td>) sit in a tight justify-between flex row,
  // so the inline suffix gets clipped. Stack it on a new line instead.
  const tag   = el.tagName;
  const block = tag === "TD" || (tag === "SPAN" && el.classList.contains("h5"));
  upsertSuffixInside(el, ` (~ ${formatCurrency(cad * rate * vatMultiplier, currency)})`, { block });
}

function convertCheckout(el, rate, currency) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) { clearSuffixInside(el); return; }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  // Straight CAD→local currency; no VAT added — taxes are already shown as a
  // separate line by Shopify, so adding VAT here would double-count them.
  upsertSuffixInside(el, ` (~ ${formatCurrency(cad * rate, currency)})`);

  const suffix = el.querySelector(`:scope > span.${SUFFIX_CLASS}`);
  if (suffix) suffix.style.opacity = "0.55";
}

// ── Target finding ────────────────────────────────────────────────────────────
// Cart-drawer Total + free-shipping bar, which can appear on any store page
// when the user opens the side drawer. Returns leaf nodes containing a $ amount.
function findDrawerOverlayTargets(root, out) {
  root.querySelectorAll("cart-drawer span.h5").forEach((n) => {
    if (n.children.length > 0) return;
    const t = n.textContent || "";
    if (!t.includes("$")) return;
    if (parseAmountFromDollarText(t) !== null) out.add(n);
  });
  // Free-shipping progress bar: "Spend CA$X.XX more and get free shipping!"
  // Target the inner highlighted price span so the suffix renders inline
  // right after the amount ("CA$205.01 (~ €X.XX) more …") instead of being
  // pushed to the end of the sentence.
  root.querySelectorAll("free-shipping-bar .text-accent").forEach((n) => {
    if (n.children.length > 0) return;
    const t = n.textContent || "";
    if (!t.includes("$")) return;
    if (parseAmountFromDollarText(t) !== null) out.add(n);
  });
}

function findTargets(kind, root = document) {
  if (kind === "store") {
    const out = new Set();
    // Current theme: <price-list><sale-price>$X.XX CAD</sale-price></price-list>
    root.querySelectorAll("price-list sale-price, price-list compare-at-price").forEach((n) => {
      const t = n.textContent || "";
      if (t.includes("$") && t.includes("CAD")) out.add(n);
    });
    // Legacy fallback for older theme versions.
    root.querySelectorAll(".price-item").forEach((n) => {
      const t = n.textContent || "";
      if (t.includes("$") && t.includes("CAD")) out.add(n);
    });
    // Cart drawer can be opened on any store page; convert its totals too.
    findDrawerOverlayTargets(root, out);
    return Array.from(out);
  }

  if (kind === "cart") {
    // Fast path: try known specific selectors first
    const CART_SELECTORS = [
      // Current theme: custom elements for line-item prices
      "price-list sale-price",
      "price-list compare-at-price",
      // Legacy line-item selectors
      ".price.price--center.th_item_line_price",
      ".price--center.th_item_line_price",
      ".th_item_line_price .price",
      "span.price",
      // Totals (current + legacy)
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

    // Totals in the current theme are plain .h5 spans next to a "Total"/"Subtotal"
    // label, and the desktop cart table shows a per-line price in a bare <td>.
    // Match these directly (leaf nodes containing a parseable $ amount) rather
    // than waiting for the structural fallback, because the line-item selectors
    // above already produced hits and would suppress the fallback.
    root.querySelectorAll("span.h5, td").forEach((n) => {
      if (n.children.length > 0) return;
      const t = n.textContent || "";
      if (!t.includes("$")) return;
      if (parseAmountFromDollarText(t) !== null) out.add(n);
    });

    // "Spend CA$X.XX more and get free shipping!" progress bar — target the
    // inner price span so the suffix renders inline next to the amount.
    root.querySelectorAll("free-shipping-bar .text-accent").forEach((n) => {
      if (n.children.length > 0) return;
      const t = n.textContent || "";
      if (!t.includes("$")) return;
      if (parseAmountFromDollarText(t) !== null) out.add(n);
    });

    // Structural fallback: anchor to cart container and scan for price-like leaf nodes.
    // Activates when the LTT Store theme changes and the selector list returns nothing.
    if (out.size === 0) {
      const cartRoot = root.querySelector(
        'form[action="/cart"], cart-drawer, [data-section-type="cart"], #cart, main'
      ) || root;
      cartRoot.querySelectorAll("span, p, div, sale-price, compare-at-price").forEach((n) => {
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

  // Read currency first so the loading badge can show the right symbol.
  const currency = await getTargetCurrency();
  showLoadingIndicator(currency);

  try {
    // Fetch rates, VAT multiplier, and raw VAT % in parallel (currency already known).
    const [rates, vatMultiplier, vatPct] = await Promise.all([
      getRatesFromBackground(),
      getVatMultiplier(),
      getVatPercent(),
    ]);

    const rate = rates[currency];
    if (typeof rate !== "number") throw new Error(`No rate available for ${currency}`);

    const targets = findTargets(kind);

    if (kind === "store") {
      targets.forEach((n) => {
        // Cart drawer overlay elements (Total, free-shipping bar) live inside
        // <cart-drawer> / <free-shipping-bar> and don't always include "CAD".
        // Dispatch them through the cart converter so the suffix is appended
        // regardless of the strict "CAD" check used for store price-list items.
        if (n.closest("cart-drawer, free-shipping-bar")) {
          convertCartPrice(n, rate, vatMultiplier, currency);
        } else {
          convertStorePriceItem(n, rate, vatMultiplier, currency);
        }
      });
    } else if (kind === "cart") {
      targets.forEach((n) => convertCartPrice(n, rate, vatMultiplier, currency));
    } else if (kind === "checkout") {
      targets.forEach((n) => convertCheckout(n, rate, currency));
      if (pageLoaded) scheduleTaxNotice(rate, vatPct, currency);
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

// ── Page-load gate for tax notice ─────────────────────────────────────────────
// Shopify's checkout renders tax/duties rows asynchronously via React even
// after window.load. We debounce the tax notice separately with a longer
// settle delay: every updateAll() call resets the timer, so the notice only
// appears once Shopify's mutations have stopped for TAX_NOTICE_SETTLE_MS.
const TAX_NOTICE_SETTLE_MS = 500;
let taxNoticeTimer = null;

function scheduleTaxNotice(rate, vatPct, currency) {
  clearTimeout(taxNoticeTimer);
  taxNoticeTimer = setTimeout(() => updateTaxNotice(rate, vatPct, currency), TAX_NOTICE_SETTLE_MS);
}

let pageLoaded = document.readyState === "complete";
if (!pageLoaded) {
  window.addEventListener("load", () => { pageLoaded = true; scheduleUpdate(); }, { once: true });
}

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
