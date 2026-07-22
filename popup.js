/**
 * FlexyPe Store Diagnostics — popup.js
 *
 * Flow:
 * 1. Get the active tab.
 * 2. Inject `scanShopifyStore` (defined below) directly into that tab via
 *    chrome.scripting.executeScript. This function runs INSIDE the page's
 *    context, so it can read window.Shopify, <script> tags, DOM, etc.
 * 3. Render the returned JSON into the popup UI.
 *
 * NOTE: `scanShopifyStore` is passed as `func`, which means it is
 * serialized and executed in an isolated world in the page. It must be a
 * fully self-contained function — no references to outer variables from
 * this file are allowed inside it.
 */

// ---------------------------------------------------------------------------
// 1. THE SCANNER (runs inside the inspected page)
// ---------------------------------------------------------------------------
function scanShopifyStore() {
  const result = {
    isShopify: false,
    storeInfo: {},
    flexypeProducts: {},
    disabledIntegrations: [],
    thirdPartyApps: [],
    warnings: []
  };

  // ---- Helpers -------------------------------------------------------
  function detectPageType() {
    try {
      if (window.meta && window.meta.page && window.meta.page.pageType) {
        return window.meta.page.pageType;
      }
    } catch (e) {}
    const path = window.location.pathname;
    if (path === '/') return 'Home';
    if (path.includes('/products/')) return 'Product';
    if (path.includes('/collections/')) return 'Collection';
    if (path.includes('/cart')) return 'Cart';
    if (path.includes('/checkout')) return 'Checkout';
    if (path.includes('/pages/')) return 'Page';
    return 'Other';
  }

  // ---- STORE INFO ------------------------------------------------------
  try {
    const S = window.Shopify || {};
    const ogSiteName = document.querySelector('meta[property="og:site_name"]');
    const hasShopifyCdn = !!document.querySelector('link[href*="cdn.shopify.com"], script[src*="cdn.shopify.com"]');

    result.isShopify = !!S.shop || hasShopifyCdn || !!window.ShopifyAnalytics;

    result.storeInfo = {
      'Store URL': window.location.hostname || 'Not Detected',
      'Shop Name': (S.shop && S.shop.split('.')[0]) || (ogSiteName && ogSiteName.content) || 'Not Detected',
      'Base Currency': (S.currency && (S.currency.active || S.currency)) || 'Not Detected',
      'Country': S.country || 'Not Detected',
      'Locale': S.locale || document.documentElement.lang || 'Not Detected',
      'Shopify Domain': S.shop || 'Not Detected',
      'Theme Name': (S.theme && S.theme.name) || 'Not Detected',
      'Theme ID': (S.theme && String(S.theme.id)) || 'Not Detected',
      'Current Page': detectPageType()
    };
  } catch (e) {
    result.warnings.push('storeInfo error: ' + e.message);
  }

  // ---- GATHER RAW SIGNALS ----------------------------------------------
  const scriptEls = Array.from(document.scripts);
  const scriptSrcs = scriptEls.map((s) => s.src).filter(Boolean);
  const inlineScriptText = scriptEls
    .filter((s) => !s.src)
    .map((s) => s.textContent || '')
    .join('\n');
  const htmlSource = document.documentElement.outerHTML;

  // ---- FLEXYPE PRODUCT SIGNATURES --------------------------------------
  // Confirmed via live DevTools investigation on zouraofficial.com
  // (Network tab filenames, DOM search, and window key enumeration),
  // cross-checked against aseemshakti.com (Checkout-only control):
  //   - FlexyPe Checkout -> loads "flexype-v2.min.js", logs
  //     "🚀 Checkout Powered By FlexyPe!"
  //   - FlexyCart          -> loads "flexype-cart-entry.min.js", logs
  //     "🛒 Cart Powered By FlexyPe!"
  //   - FlexyPass           -> loads ".../flexypass-<id>/assets/pass.min.js"
  //     (no console banner). DOM uses "flexy-pass" (hyphenated, not
  //     "flexypass") for ids/classes, e.g. #flexy-pass-header-wrapper,
  //     #flexy-pass, #flexy-pass-iframe. Globals: flexyPassActive,
  //     openFlexyPass, closeFlexyPass, flexyPassConfig, flexyPassUser,
  //     flexyPassMid, flexyPassEnv, flexyPassConsent, flexyPassNewFlow,
  //     flexyPassAxentraConfig, flexyPassConfigPromise.
  const PRODUCT_SIGNATURES = {
    'FlexyPe Checkout': {
      scriptPatterns: [/flexype-v\d+(\.min)?\.js/i, /flexype[-_.]?checkout/i],
      domSelectors: ['[id*="flexype-checkout" i]', '[class*="flexype-checkout" i]', '[data-flexype-checkout]'],
      globalVars: ['FlexyPeCheckout', 'flexypeCheckout', '__FLEXYPE_CHECKOUT__', 'FlexyPe', 'openFlexyCheckout'],
      consolePatterns: [/checkout powered by flexype/i]
    },
    FlexyPass: {
      scriptPatterns: [/flexypass[-\w]*\/assets\/pass\.min\.js/i, /flexypass.*pass\.min\.js/i],
      domSelectors: ['[id*="flexy-pass" i]', '[class*="flexy-pass" i]'],
      globalVars: [
        'flexyPassActive',
        'openFlexyPass',
        'closeFlexyPass',
        'flexyPassConfig',
        'flexyPassUser',
        'flexyPassMid',
        'flexyPassEnv'
      ],
      consolePatterns: [] // confirmed: FlexyPass prints no console banner
    },
    FlexyCart: {
      scriptPatterns: [/flexype-cart-entry(\.min)?\.js/i, /flexy[-_.]?cart/i],
      domSelectors: ['[id*="flexycart" i]', '[class*="flexycart" i]', '[data-flexycart]'],
      globalVars: ['FlexyCart', 'flexyCart', '__FLEXYCART__'],
      consolePatterns: [/cart powered by flexype/i]
    }
  };

  const capturedConsoleLogs = (window.__flexypeSignals && window.__flexypeSignals.consoleLogs) || [];

  for (const [product, sig] of Object.entries(PRODUCT_SIGNATURES)) {
    const evidence = [];

    const matchedScripts = scriptSrcs.filter((src) => sig.scriptPatterns.some((p) => p.test(src)));
    matchedScripts.slice(0, 1).forEach((s) => evidence.push('Script src: ' + s));

    if (sig.consolePatterns) {
      const matchedLog = capturedConsoleLogs.find((log) => sig.consolePatterns.some((p) => p.test(log)));
      if (matchedLog) evidence.push('Console banner: "' + matchedLog + '"');
    }

    for (const sel of sig.domSelectors) {
      try {
        if (document.querySelector(sel)) {
          evidence.push('DOM selector matched: ' + sel);
          break;
        }
      } catch (e) {
        /* invalid selector, skip */
      }
    }

    for (const g of sig.globalVars) {
      if (typeof window[g] !== 'undefined') {
        evidence.push('Global object: window.' + g);
        break;
      }
    }

    if (evidence.length === 0) {
      sig.scriptPatterns.forEach((p) => {
        if (p.test(inlineScriptText)) evidence.push('Referenced in inline script (pattern: ' + p + ')');
      });
    }

    result.flexypeProducts[product] = {
      status: evidence.length ? 'Detected' : 'Not Detected',
      evidence: evidence.slice(0, 3)
    };
  }

  // ---- DISABLED / COMMENTED-OUT INTEGRATIONS ---------------------------
  // 1. HTML comments mentioning flexype
  try {
    const commentRegex = /<!--([\s\S]*?)-->/g;
    let m;
    while ((m = commentRegex.exec(htmlSource)) !== null) {
      if (/flexype/i.test(m[1])) {
        result.disabledIntegrations.push({
          type: 'HTML comment',
          snippet: m[1].trim().slice(0, 220)
        });
      }
    }
  } catch (e) {}

  // 2. Disabled <script> tags (type="text/disabled-script" or [disabled])
  document
    .querySelectorAll('script[type*="disabled" i], script[disabled], script[type="text/plain"]')
    .forEach((s) => {
      const src = s.src || '';
      const body = s.textContent || '';
      if (/flexype/i.test(src) || /flexype/i.test(body)) {
        result.disabledIntegrations.push({
          type: 'Disabled <script> tag',
          snippet: (src || body).slice(0, 220)
        });
      }
    });

  // 3. Hidden DOM containers referencing flexype
  document.querySelectorAll('[style*="display:none" i], [style*="display: none" i], [hidden]').forEach((el) => {
    const idClass = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
    if (idClass.includes('flexype')) {
      result.disabledIntegrations.push({
        type: 'Hidden DOM container',
        snippet: el.outerHTML.slice(0, 220)
      });
    }
  });

  // 4. JS-style comments referencing flexype inside inline scripts
  try {
    const jsCommentRegex = /(\/\/[^\n]*flexype[^\n]*|\/\*[\s\S]*?flexype[\s\S]*?\*\/)/gi;
    let jm;
    while ((jm = jsCommentRegex.exec(inlineScriptText)) !== null) {
      result.disabledIntegrations.push({
        type: 'Commented-out JavaScript',
        snippet: jm[0].slice(0, 220)
      });
    }
  } catch (e) {}

  // Deduplicate disabled integrations by snippet
  const seen = new Set();
  result.disabledIntegrations = result.disabledIntegrations.filter((d) => {
    if (seen.has(d.snippet)) return false;
    seen.add(d.snippet);
    return true;
  });

  // ---- THIRD-PARTY APPS --------------------------------------------------
  const KNOWN_APPS = {
    Klaviyo: /klaviyo/i,
    'Judge.me': /judge\.?me/i,
    Yotpo: /yotpo/i,
    Loox: /loox/i,
    ReCharge: /rechargepayments|recharge\.com/i,
    Gorgias: /gorgias/i,
    PageFly: /pagefly/i,
    Shogun: /getshogun|shogun/i,
    Privy: /privy\.com/i,
    Bold: /boldapps|bold\.com/i,
    'Smile.io': /smile\.io/i,
    Attentive: /attentivemobile/i,
    Postscript: /postscript\.io/i,
    'Return Prime': /returnprime|return_prime/i,
    'Google Tag Manager / Analytics': /googletagmanager|google-analytics/i,
    'Meta / Facebook Pixel': /connect\.facebook\.net/i,
    'TikTok Pixel': /analytics\.tiktok\.com/i,
    Hotjar: /hotjar/i,
    Zendesk: /zendesk/i,
    Tidio: /tidio/i,
    'Rebuy Engine': /rebuyengine/i,
    Okendo: /okendo/i
  };

  const foundApps = new Set();
  scriptSrcs.forEach((src) => {
    for (const [app, pattern] of Object.entries(KNOWN_APPS)) {
      if (pattern.test(src)) foundApps.add(app);
    }
  });
  result.thirdPartyApps = Array.from(foundApps);

  return result;
}

// ---------------------------------------------------------------------------
// 2. POPUP CONTROLLER (runs in the extension popup, NOT the page)
// ---------------------------------------------------------------------------
const statusText = document.getElementById('statusText');
const notShopifyBanner = document.getElementById('notShopifyBanner');

function setStatus(msg) {
  statusText.textContent = msg;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function runScan() {
  setStatus('Scanning…');
  const tab = await getActiveTab();

  if (!tab || !tab.id || !/^https?:/.test(tab.url || '')) {
    setStatus('Open a storefront tab, then click ⟳');
    renderEmptyState();
    return;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanShopifyStore
    });
    render(result);
    setStatus('Last scanned: ' + new Date().toLocaleTimeString());
  } catch (err) {
    setStatus('Could not scan this page (' + err.message + ')');
    renderEmptyState();
  }
}

function renderEmptyState() {
  document.getElementById('storeInfoTable').innerHTML = '<tr><td colspan="2" class="empty-state">No data</td></tr>';
  document.getElementById('productsList').innerHTML = '<div class="empty-state">No data</div>';
  document.getElementById('disabledList').innerHTML = '<div class="empty-state">No data</div>';
  document.getElementById('appsList').innerHTML = '<div class="empty-state">No data</div>';
}

function render(data) {
  if (!data) {
    renderEmptyState();
    return;
  }

  notShopifyBanner.classList.toggle('hidden', !!data.isShopify);

  // --- Store Info tab ---
  const table = document.getElementById('storeInfoTable');
  table.innerHTML = Object.entries(data.storeInfo)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`)
    .join('');

  // --- FlexyPe Products tab ---
  const productsList = document.getElementById('productsList');
  productsList.innerHTML = Object.entries(data.flexypeProducts)
    .map(([name, info]) => {
      const badgeClass = info.status === 'Detected' ? 'badge-detected' : 'badge-not-detected';
      const evidenceHtml = info.evidence.length
        ? `<ul class="evidence-list">${info.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
        : '';
      return `
        <div class="card">
          <div class="card-title-row">
            <span class="card-title">${escapeHtml(name)}</span>
            <span class="badge ${badgeClass}">${info.status}</span>
          </div>
          ${evidenceHtml}
        </div>`;
    })
    .join('');

  // --- Disabled Integrations tab ---
  const disabledList = document.getElementById('disabledList');
  if (!data.disabledIntegrations.length) {
    disabledList.innerHTML = '<div class="empty-state">No disabled or commented-out FlexyPe integrations found.</div>';
  } else {
    disabledList.innerHTML = data.disabledIntegrations
      .map(
        (d) => `
        <div class="card">
          <div class="card-title-row">
            <span class="card-title">${escapeHtml(d.type)}</span>
            <span class="badge badge-disabled">Disabled</span>
          </div>
          <div class="snippet">${escapeHtml(d.snippet)}</div>
        </div>`
      )
      .join('');
  }

  // --- Third-Party Apps tab ---
  const appsList = document.getElementById('appsList');
  appsList.innerHTML = data.thirdPartyApps.length
    ? data.thirdPartyApps.map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join('')
    : '<div class="empty-state">No known third-party apps detected.</div>';

  // --- Bonus Config tab ---
  renderConfigButtons(data.flexypeProducts);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// 3. BONUS: fetch product configuration from the FlexyPe backend
// ---------------------------------------------------------------------------
// NOTE: FlexyPe does not expose a public config API for this assignment, so
// this calls a placeholder endpoint. Swap FLEXYPE_CONFIG_API for the real
// endpoint if/when one is provided, and add an auth header if required.
const FLEXYPE_CONFIG_API = 'https://api.flexype.io/v1/config'; // TODO: replace with real endpoint

function renderConfigButtons(products) {
  const container = document.getElementById('configButtons');
  const detected = Object.entries(products).filter(([, info]) => info.status === 'Detected');

  if (!detected.length) {
    container.innerHTML = '<div class="empty-state">No FlexyPe products detected on this store.</div>';
    return;
  }

  container.innerHTML = detected
    .map(
      ([name]) => `
      <div class="card">
        <div class="card-title-row">
          <span class="card-title">${escapeHtml(name)}</span>
          <button class="mini-btn" data-product="${escapeHtml(name)}">Fetch Config</button>
        </div>
      </div>`
    )
    .join('');

  container.querySelectorAll('.mini-btn').forEach((btn) => {
    btn.addEventListener('click', () => fetchConfig(btn.dataset.product, btn));
  });
}

async function fetchConfig(productName, btn) {
  const output = document.getElementById('configOutput');
  output.classList.remove('hidden');
  output.textContent = 'Fetching configuration for ' + productName + '…';
  btn.disabled = true;

  try {
    const tab = await getActiveTab();
    const shop = new URL(tab.url).hostname;

    const res = await fetch(
      `${FLEXYPE_CONFIG_API}?shop=${encodeURIComponent(shop)}&product=${encodeURIComponent(productName)}`
    );
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    output.textContent = JSON.stringify(json, null, 2);
  } catch (err) {
    output.textContent =
      `Could not reach the FlexyPe config API (${err.message}).\n\n` +
      `This is expected in this assignment since no live backend is provided.\n` +
      `In production, this button would call:\n${FLEXYPE_CONFIG_API}?shop=${productName}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 4. TABS + INIT
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

document.getElementById('rescanBtn').addEventListener('click', runScan);

runScan();
