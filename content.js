/**
 * Runs at document_start to capture FlexyPe console banners into
 * window.__flexypeSignals before the popup is opened.
 */
(function () {
  if (window.__flexypeSignals) return; // avoid double-wrapping

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
