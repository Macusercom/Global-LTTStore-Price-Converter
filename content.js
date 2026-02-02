const VAT_MULTIPLIER_STORE_CART = 1.20; // 20% VAT (store + cart only)
const VAT_MULTIPLIER_CHECKOUT = 1.00;   // checkout: conversion only (no added VAT)

const SUFFIX_CLASS = "kesch-eur-suffix";
// Matches "(€ 12,34)" already appended by older versions (tolerates spacing).
const EUR_SUFFIX_RE = /\s*\(\s*€\s*[\d.,]+?\s*\)\s*$/;

const EUR_FORMATTER = new Intl.NumberFormat("de-DE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatEur(value) {
  return `€ ${EUR_FORMATTER.format(value)}`;
}

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

  // On Shopify checkout domains, use a light heuristic so we don't touch unrelated stores.
  const title = (document.title || "").toLowerCase();
  if (title.includes("lttstore")) return true;

  const ogSite = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || "";
  if (ogSite.toLowerCase().includes("lttstore")) return true;

  return false;
}

function parseAmountFromDollarText(text) {
  // Supports:
  // - "$39.99 CAD"
  // - "$99.99"
  // - "$ 99,99" (NBSP + comma decimals)
  const t = String(text || "").replace(/\u00A0/g, " ");
  const m = t.match(/\$\s*([0-9][0-9\s.,]*)/);
  if (!m) return null;

  let num = m[1].replace(/\s/g, "");
  num = num.replace(/[.,]+$/, "");

  const hasDot = num.includes(".");
  const hasComma = num.includes(",");

  if (hasDot && hasComma) {
    if (num.lastIndexOf(",") > num.lastIndexOf(".")) {
      num = num.replace(/\./g, "").replace(",", ".");
    } else {
      num = num.replace(/,/g, "");
    }
  } else if (hasComma) {
    const last = num.lastIndexOf(",");
    const frac = num.length - last - 1;
    if (frac === 1 || frac === 2) num = num.replace(/\./g, "").replace(",", ".");
    else num = num.replace(/,/g, "");
  } else if (hasDot) {
    const last = num.lastIndexOf(".");
    const frac = num.length - last - 1;
    if (frac === 1 || frac === 2) num = num.replace(/,/g, "");
    else num = num.replace(/\./g, "");
  }

  const val = Number.parseFloat(num);
  return Number.isFinite(val) ? val : null;
}

async function getRateFromBackground() {
  const resp = await chrome.runtime.sendMessage({ type: "GET_CAD_EUR_RATE" });
  if (!resp?.ok) throw new Error(resp?.error || "Rate unavailable");
  return resp.rate;
}

function upsertSuffixInside(el, suffixText) {
  // If the element is plain text, strip legacy text-based suffix first.
  if (el.childElementCount === 0) {
    const raw = (el.textContent || "");
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

function convertStorePriceItem(el, rate) {
  // Store: keep exactly the " (€ ...)" bracket style (no injected spans).
  const raw = (el.textContent || "").trim();
  if (!raw.includes("CAD") || !raw.includes("$")) return;

  const base = raw.replace(EUR_SUFFIX_RE, "").trim();
  const cad = parseAmountFromDollarText(base);
  if (cad === null) return;

  const eurGross = cad * rate * VAT_MULTIPLIER_STORE_CART;
  const next = `${base} (${formatEur(eurGross)})`;
  if (raw !== next) el.textContent = next;
}

function convertCartPrice(el, rate) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) {
    clearSuffixInside(el);
    return;
  }
  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  const eurGross = cad * rate * VAT_MULTIPLIER_STORE_CART;
  upsertSuffixInside(el, ` (${formatEur(eurGross)})`);
}

function isEstimatedTaxesRow(el) {
  const row = el.closest("[role='row'], tr, li, div");
  const t = (row?.textContent || "").toLowerCase();
  const hasTaxWord = t.includes("tax") || t.includes("steuern") || t.includes("steuer");
  const looksLikeTotal = t.includes("total");
  return hasTaxWord && !looksLikeTotal;
}

function findCheckoutTotalsAndTaxes(root) {
  const strongs = Array.from(root.querySelectorAll("strong"))
    .filter((n) => (n.textContent || "").includes("$"));

  const parsed = strongs
    .map((n) => ({ n, v: parseAmountFromDollarText(n.textContent || "") }))
    .filter((x) => typeof x.v === "number");

  let totalNode = null;
  let totalVal = null;
  if (parsed.length) {
    parsed.sort((a, b) => b.v - a.v);
    totalNode = parsed[0].n;
    totalVal = parsed[0].v;
  }

  const taxCandidates = Array.from(root.querySelectorAll("span, div, p, strong"))
    .filter((n) => (n.textContent || "").includes("$") && isEstimatedTaxesRow(n))
    .map((n) => parseAmountFromDollarText(n.textContent || ""))
    .filter((v) => typeof v === "number");

  let taxVal = null;
  if (taxCandidates.length) taxVal = Math.max(...taxCandidates);

  return { totalNode, totalVal, taxVal };
}

function convertCheckout(el, rate, ctx) {
  const raw = (el.textContent || "").trim();
  if (!raw.includes("$")) {
    clearSuffixInside(el);
    return;
  }

  // Never append EUR to the "Estimated taxes" line item itself.
  if (isEstimatedTaxesRow(el)) {
    clearSuffixInside(el);
    return;
  }

  const cad = parseAmountFromDollarText(raw);
  if (cad === null) return;

  // For grand total: subtract estimated taxes first (so the displayed EUR total is tax-excluded).
  if (ctx?.totalNode && el === ctx.totalNode && typeof ctx.totalVal === "number" && typeof ctx.taxVal === "number") {
    const netCad = Math.max(0, ctx.totalVal - ctx.taxVal);
    const eur = netCad * rate * VAT_MULTIPLIER_CHECKOUT; // conversion only
    upsertSuffixInside(el, ` (${formatEur(eur)})`);
    return;
  }

  const eur = cad * rate * VAT_MULTIPLIER_CHECKOUT; // conversion only
  upsertSuffixInside(el, ` (${formatEur(eur)})`);
}

function findTargets(kind, root = document) {
  if (kind === "store") {
    return Array.from(root.querySelectorAll(".price-item"))
      .filter((n) => (n.textContent || "").includes("$") && (n.textContent || "").includes("CAD"));
  }

  if (kind === "cart") {
    const selectors = [
      ".price.price--center.th_item_line_price",
      ".price--center.th_item_line_price",
      ".th_item_line_price .price",
      "span.price",
      "p.totals__subtotal-value.th_cart_total_price",
      ".totals__subtotal-value",
      ".th_cart_total_price",
    ];
    const out = new Set();
    for (const sel of selectors) {
      root.querySelectorAll(sel).forEach((n) => {
        if ((n.textContent || "").includes("$")) out.add(n);
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

let scheduled = false;

async function updateAll() {
  if (!isLikelyLttContext()) return;

  const kind = pageKind();
  if (kind === "other") return;

  try {
    const rate = await getRateFromBackground();
    const targets = findTargets(kind);

    if (kind === "store") {
      targets.forEach((n) => convertStorePriceItem(n, rate));
      return;
    }

    if (kind === "cart") {
      targets.forEach((n) => convertCartPrice(n, rate));
      return;
    }

    if (kind === "checkout") {
      const ctx = findCheckoutTotalsAndTaxes(document);
      targets.forEach((n) => convertCheckout(n, rate, ctx));
      return;
    }
  } catch {
    // ignore
  }
}

function scheduleUpdate() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    updateAll();
  }, 200);
}

scheduleUpdate();

const obs = new MutationObserver(() => scheduleUpdate());
obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
window.addEventListener("popstate", scheduleUpdate);
