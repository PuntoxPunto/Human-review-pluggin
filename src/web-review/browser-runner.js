import { assertSafeHttpUrl } from "./url-policy.js";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const PASSIVE_PROTOCOLS = new Set(["about:", "data:", "blob:"]);

export class BrowserRunner {
  constructor({ allowPrivateTargets = false, loadPlaywright } = {}) {
    this.allowPrivateTargets = allowPrivateTargets;
    this.loadPlaywright = loadPlaywright ?? (() => import("playwright"));
  }

  async capture({ url, viewport = { width: 1440, height: 900 }, timeoutMs = 30_000 }) {
    const safeUrl = await assertSafeHttpUrl(url, { allowPrivate: this.allowPrivateTargets });
    const { chromium } = await this.loadPlaywright();
    const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });

    const consoleErrors = [];
    const networkErrors = [];

    try {
      await context.route("**/*", async (route) => {
        const requestUrl = route.request().url();
        let parsed;
        try {
          parsed = new URL(requestUrl);
        } catch {
          return route.abort("blockedbyclient");
        }

        if (PASSIVE_PROTOCOLS.has(parsed.protocol)) return route.continue();
        if (!HTTP_PROTOCOLS.has(parsed.protocol)) return route.abort("blockedbyclient");

        try {
          await assertSafeHttpUrl(requestUrl, { allowPrivate: this.allowPrivateTargets });
          return route.continue();
        } catch {
          networkErrors.push({ url: requestUrl, error: "blocked_unsafe_target" });
          return route.abort("blockedbyclient");
        }
      });

      const page = await context.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 2000));
      });
      page.on("pageerror", (error) => consoleErrors.push(String(error.message || error).slice(0, 2000)));
      page.on("requestfailed", (request) => {
        const failure = request.failure();
        const url = request.url();
        if (!networkErrors.some((item) => item.url === url && item.error === "blocked_unsafe_target")) {
          networkErrors.push({ url, error: failure?.errorText || "request_failed" });
        }
      });

      await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      try {
        await page.waitForLoadState("load", { timeout: Math.min(5_000, timeoutMs) });
      } catch {
        // Some apps keep secondary resources pending; DOMContentLoaded remains the hard gate.
      }
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const metadata = await page.evaluate(() => {
        const MAX_ELEMENTS = 600;
        const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const selectorHint = (element) => {
          const tag = element.tagName.toLowerCase();
          if (element.id) return `${tag}#${CSS.escape(element.id)}`;
          const classes = Array.from(element.classList || []).filter(Boolean).slice(0, 3);
          return classes.length ? `${tag}.${classes.map((name) => CSS.escape(name)).join(".")}` : tag;
        };
        const domPath = (element) => {
          const parts = [];
          let current = element;
          while (current && current.nodeType === 1 && current !== document.documentElement) {
            const tag = current.tagName.toLowerCase();
            if (current.id) {
              parts.unshift(`${tag}#${CSS.escape(current.id)}`);
              break;
            }
            let part = tag;
            const parent = current.parentElement;
            if (parent) {
              const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
              if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
            }
            parts.unshift(part);
            current = parent;
          }
          return parts.join(" > ");
        };
        const elements = [];
        for (const element of document.querySelectorAll("body *")) {
          if (elements.length >= MAX_ELEMENTS) break;
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          const style = getComputedStyle(element);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
          const intersectsViewport = rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
          if (!intersectsViewport) continue;
          const text = normalize(element.innerText || element.textContent).slice(0, 180);
          const name = normalize(element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || text).slice(0, 180);
          elements.push({
            tag: element.tagName.toLowerCase(),
            selector: selectorHint(element),
            path: domPath(element),
            parentPath: element.parentElement ? domPath(element.parentElement) : null,
            role: element.getAttribute("role") || null,
            name: name || null,
            text: text || null,
            rect: {
              x: Math.round(rect.x * 10) / 10,
              y: Math.round(rect.y * 10) / 10,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
              top: Math.round(rect.top * 10) / 10,
              right: Math.round(rect.right * 10) / 10,
              bottom: Math.round(rect.bottom * 10) / 10,
              left: Math.round(rect.left * 10) / 10,
            },
            position: style.position,
            zIndex: style.zIndex,
            overflowX: style.overflowX,
            overflowY: style.overflowY,
          });
        }
        const root = document.documentElement;
        const body = document.body;
        return {
          title: document.title,
          scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
          viewport: { width: innerWidth, height: innerHeight },
          document: {
            scrollWidth: Math.max(root.scrollWidth, body?.scrollWidth || 0),
            scrollHeight: Math.max(root.scrollHeight, body?.scrollHeight || 0),
            clientWidth: root.clientWidth,
            clientHeight: root.clientHeight,
          },
          structure: elements,
        };
      });

      const screenshot = await page.screenshot({ type: "png", fullPage: false, animations: "allow", scale: "css" });
      return {
        finalUrl: page.url(),
        title: metadata.title,
        viewport: metadata.viewport,
        scroll: metadata.scroll,
        document: metadata.document,
        structure: metadata.structure,
        screenshotBase64: screenshot.toString("base64"),
        consoleErrors,
        networkErrors,
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}
