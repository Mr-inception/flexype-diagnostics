# FlexyPe Store Diagnostics — Chrome Extension

A Manifest V3 Chrome extension that lets a Sales/Support engineer open any
Shopify storefront and instantly see:

- Core store info (URL, shop name, currency, country, locale, theme, current page)
- Which FlexyPe products are live (Checkout / FlexyPass / FlexyCart)
- Disabled or commented-out FlexyPe integrations
- Third-party Shopify apps detected on the page
- (Bonus) A button to pull each detected product's backend configuration

No backend service is required for the core features — everything runs
client-side by injecting a scanner into the active tab.

## Folder Structure

```
flexype-diagnostics/
├── manifest.json     # MV3 manifest (activeTab + scripting + content_scripts)
├── content.js        # Runs at document_start; captures FlexyPe console banners early
├── popup.html         # Popup UI shell (tabs: Store / Products / Disabled / Apps / Config)
├── popup.css          # Styling
├── popup.js           # On-demand scanner logic + UI rendering + bonus config fetch
└── README.md
```

## Setup / How to Run

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select the `flexype-diagnostics` folder.
4. Pin the extension (puzzle-piece icon → pin "FlexyPe Store Diagnostics").
5. Visit any Shopify storefront (e.g. a `.myshopify.com` domain or a store
   using Shopify checkout) and click the extension icon.
6. The popup automatically scans the page. Click the ⟳ button to re-scan
   after navigating (e.g. from Home to a Product page).

## Detection Approach

### Store Info
Reads `window.Shopify` (shop, currency, country, locale, theme) which
Shopify injects globally on storefronts, falling back to `<meta
property="og:site_name">` and `document.documentElement.lang` when a field
isn't present. Current page type is inferred from `window.meta.page.pageType`
when available, otherwise from the URL path (`/products/`, `/collections/`,
`/cart`, `/checkout`).

### FlexyPe Product Detection (Checkout / FlexyPass / FlexyCart)
Rather than one hardcoded selector, each product is checked against four
independent signal types, and a product is marked **Detected** if *any*
signal matches (evidence is shown in the popup so you can see *why*):

1. **Script src patterns** — regex match against every `<script src="...">` on
   the page. Confirmed via live DevTools investigation on
   `zouraofficial.com`: FlexyPe Checkout loads `flexype-v2.min.js`, FlexyCart
   loads `flexype-cart-entry.min.js`.
2. **Console banners** — FlexyPe's own scripts print an identifying banner on
   load (e.g. `🚀 Checkout Powered By FlexyPe!`, `🛒 Cart Powered By
   FlexyPe!`). Because the popup only runs after the user clicks the icon —
   well after these banners would have already printed — `content.js` runs
   at `document_start` and wraps `console.log/info/warn` to buffer any
   FlexyPe-related banner into `window.__flexypeSignals.consoleLogs`, which
   the scanner reads later. This is the most reliable signal found so far.
3. **DOM selectors** — `id`/`class`/`data-*` attributes referencing the
   product (e.g. `[data-flexype-checkout]`).
4. **Global JS objects** — checks `window` for product-specific globals the
   FlexyPe snippet typically exposes (e.g. `window.FlexyPass`).
5. **Inline script references** — regex scan of inline `<script>` contents
   for the same patterns, in case the integration is loaded without a
   discrete `src`.

> **Status: all three products confirmed against live traffic.**
> - **FlexyPe Checkout** — script `flexype-v2.min.js`, console banner "🚀 Checkout Powered By FlexyPe!"
> - **FlexyCart** — script `flexype-cart-entry.min.js`, console banner "🛒 Cart Powered By FlexyPe!"
> - **FlexyPass** — script path `.../flexypass-<id>/assets/pass.min.js` (no console banner), DOM ids/classes use the hyphenated `flexy-pass` convention (e.g. `#flexy-pass-header-wrapper`, `#flexy-pass-iframe`), and exposes globals like `window.flexyPassActive`, `window.openFlexyPass`, `window.flexyPassConfig`.
>
> All three were verified on `zouraofficial.com` (has all three live) and cross-checked as absent on `aseemshakti.com` (Checkout-only control), confirming no false positives.

### Disabled / Commented-Out Integrations
Four independent checks, each surfaced with the exact snippet found:

1. HTML comments (`<!-- ... -->`) mentioning "flexype".
2. `<script>` tags with `type="text/disabled-script"`, `[disabled]`, or
   `type="text/plain"` (common ways themes neuter a script without deleting
   it) whose src/body mentions "flexype".
3. DOM elements with `display:none` / `[hidden]` whose `id`/`class`
   references "flexype" (leftover containers from a removed integration).
4. JS-style comments (`// ...` or `/* ... */`) inside inline scripts
   mentioning "flexype".

### Third-Party App Detection
Matches script `src` URLs against a signature dictionary of ~20 common
Shopify ecosystem apps (Klaviyo, Yotpo, Judge.me, Loox, ReCharge, Gorgias,
PageFly, GTM/GA, Meta Pixel, etc.) in `popup.js` → `KNOWN_APPS`. Extend this
dictionary as you discover more apps in the wild.

### Bonus: Product Configuration Lookup
The "Config" tab lists every **Detected** FlexyPe product with a "Fetch
Config" button that calls `FLEXYPE_CONFIG_API` (a placeholder endpoint,
since no real API was provided for this assignment) with the store's domain
and product name, and pretty-prints the JSON response. Swap in a real
endpoint and auth header when one exists.

## Validation Results

Tested live on both reference stores (screenshots in `/screenshots` — add yours here):

**zouraofficial.com** (expected: all three products live)
| Tab | Result |
|---|---|
| FlexyPe Products | All 3 Detected — Checkout via `static.flexype.in/scripts/flexype-v2.min.js`; FlexyCart via `.../flexycart-37/assets/flexype-cart-entry.min.js`; FlexyPass via `.../flexypass-85/assets/pass.min.js` + `flexy-pass` DOM selector |
| Disabled | 1 finding — an HTML comment referencing "FlexyPe" left in the page source (a leftover/disabled reference) |
| 3rd-Party Apps | Google Tag Manager / Analytics, Meta / Facebook Pixel, Judge.me |

**aseemshakti.com** (expected: Checkout only — control case)
| Tab | Result |
|---|---|
| FlexyPe Products | Checkout Detected (`static.flexype.in/scripts/flexype-v2.min.js`); FlexyPass and FlexyCart correctly **Not Detected** |

The control case confirms the detection logic doesn't false-positive on a
store that only has one of the three products live — the FlexyPass/FlexyCart
signatures (script paths, DOM selectors, globals) are specific enough to
avoid matching unrelated content.

## Known Limitations

- Detection relies on client-side signals visible in the rendered DOM/script
  tags; a product loaded purely via a server-side proxy with no client
  fingerprint would show as "Not Detected".
- The `PRODUCT_SIGNATURES` patterns need to be validated/tuned against real
  FlexyPe traffic (see note above) rather than trusted as final.
- Third-party app list is a curated sample, not exhaustive.
