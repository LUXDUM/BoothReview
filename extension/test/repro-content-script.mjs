/**
 * ビルド済み content script を vm サンドボックス (jsdom DOM + chrome モック) で起動し、
 * 「Cannot access '' before initialization」等を再現するハーネス。
 *
 *   node test/repro-content-script.mjs
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ITEM_URL = "https://booth.pm/ja/items/9026363";
const HTML = `<!doctype html><html><head><title>t</title></head><body><div id="content"><h1>item</h1></div><footer class="footer__menu bg-white">footer</footer></body></html>`;

const dom = new JSDOM(HTML, { url: ITEM_URL, pretendToBeVisual: true });
const { window } = dom;

// ---- chrome モック (content script から見た chrome) ----
const calls = [];
const chromeMock = {
  runtime: {
    id: "repro-test-extension",
    lastError: undefined,
    sendMessage(message, callback) {
      calls.push(message);
      queueMicrotask(() => {
        const resp = {
          type: "api-response",
          requestId: message.requestId,
          ok: true,
          status: 200,
          data: message.path.includes("/summary")
            ? { count: 0, average: null }
            : message.path.includes("/reviews")
              ? { reviews: [], page: 1, perPage: 10, total: 0, totalPages: 1 }
              : { review: null },
        };
        callback(resp);
      });
    },
  },
  storage: {
    local: {
      async get(_key) { return {}; },
      async set(_items) {},
    },
  },
};

const sandbox = {
  console,
  URL,
  Event,
  AbortController,
  MutationObserver: window.MutationObserver,
  setTimeout,
  setInterval,
  clearTimeout,
  clearInterval,
  queueMicrotask,
  document: window.document,
  location: window.location,
  window,
  chrome: chromeMock,
  crypto: globalThis.crypto,
};
sandbox.globalThis = sandbox;
window.chrome = chromeMock;

const errors = [];
window.addEventListener("error", (e) => errors.push(`[window error] ${e.error?.stack ?? e.message}`));
sandbox.addEventListener = (t, h) => window.addEventListener(t, h);
sandbox.removeEventListener = (t, h) => window.removeEventListener(t, h);

const bundle = readFileSync(new URL("../.output/chrome-mv3/content-scripts/booth-review.js", import.meta.url), "utf8");

vm.createContext(sandbox);
try {
  vm.runInContext(bundle, sandbox, { filename: "content-scripts/booth-review.js" });
} catch (e) {
  errors.push(`[sync eval error] ${e?.stack ?? e}`);
}

await new Promise((r) => setTimeout(r, 3000));

console.log("=== mounted host:", window.document.getElementById("boothreview-panel-host") ? "YES" : "NO");
const shadow = window.document.getElementById("boothreview-panel-host")?.shadowRoot;
console.log("=== badge host:", window.document.getElementById("boothreview-badge-host") ? "YES" : "NO");
console.log("=== summary text (shadow):", shadow?.querySelector(".br-summary")?.textContent ?? "(no panel)");
console.log("=== form visible:", shadow?.querySelector(".br-form")?.children.length ?? 0, "children");
console.log("=== api calls (sendMessage):", calls.length);
for (const c of calls) console.log("   ", c.method, c.path, c.anonId ? `(anonId: ${c.anonId})` : "");
console.log("=== errors captured:", errors.length);
for (const e of errors) console.log(e);
process.exit(errors.length ? 1 : 0);
