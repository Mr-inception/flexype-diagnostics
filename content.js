/**
 * content.js
 *
 * Runs at document_start on every page (see manifest.json content_scripts).
 * FlexyPe's own scripts print identifying banners to the console on load
 * (confirmed via DevTools investigation, e.g. "🚀 Checkout Powered By
 * FlexyPe!" and "🛒 Cart Powered By FlexyPe!"). Since the popup only runs
 * AFTER the user clicks the extension icon — well after page load — those
 * banners would already be gone from a fresh console. This script wraps
 * console.log/info/warn early so any FlexyPe-related banner is captured
 * into window.__flexypeSignals, which the on-demand scanner (popup.js)
 * reads later as one more piece of evidence.
 */
(function () {
  if (window.__flexypeSignals) return; // avoid double-wrapping on re-injection

  const logs = [];
  const KEYWORD = /flexype|flexypass|flexycart/i;

  ['log', 'info', 'warn'].forEach((method) => {
    const original = console[method];
    console[method] = function (...args) {
      try {
        const text = args
          .map((a) => {
            if (typeof a === 'string') return a;
            try {
              return JSON.stringify(a);
            } catch (e) {
              return '';
            }
          })
          .join(' ');
        if (KEYWORD.test(text)) {
          logs.push(text.slice(0, 300));
        }
      } catch (e) {
        /* never let logging interception break the page */
      }
      return original.apply(console, args);
    };
  });

  window.__flexypeSignals = { consoleLogs: logs };
})();
