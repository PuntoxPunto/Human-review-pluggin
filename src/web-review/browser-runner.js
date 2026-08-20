import { assertSafeHttpUrl } from "./url-policy.js";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const PASSIVE_PROTOCOLS = new Set(["about:", "data:", "blob:"]);

async function installSafeRouting(context, { allowPrivateTargets, networkErrors }) {
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
      await assertSafeHttpUrl(requestUrl, { allowPrivate: allowPrivateTargets });
      return route.continue();
    } catch {
      networkErrors.push({ url: requestUrl, error: "blocked_unsafe_target" });
      return route.abort("blockedbyclient");
    }
  });
}

function installDiagnostics(page, { consoleErrors, networkErrors }) {
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
}

async function settlePage(page, timeoutMs) {
  try {
    await page.waitForLoadState("load", { timeout: Math.min(5_000, timeoutMs) });
  } catch {
    // DOMContentLoaded or the action itself remains the hard gate.
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function collectMetadata(page) {
  return page.evaluate(() => {
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
}

async function snapshotPage(page, { consoleErrors, networkErrors }) {
  const metadata = await collectMetadata(page);
  const screenshot = await page.screenshot({ type: "png", fullPage: false, animations: "allow", scale: "css" });
  return {
    finalUrl: page.url(),
    title: metadata.title,
    viewport: metadata.viewport,
    scroll: metadata.scroll,
    document: metadata.document,
    structure: metadata.structure,
    screenshotBase64: screenshot.toString("base64"),
    consoleErrors: [...consoleErrors],
    networkErrors: [...networkErrors],
  };
}

async function resolveUniqueLocator(page, locatorSpec) {
  let locator;
  let descriptor;
  if (locatorSpec.strategy === "role") {
    if (!locatorSpec.role || !locatorSpec.name) throw new Error("Role locators require both role and name.");
    locator = page.getByRole(locatorSpec.role, { name: locatorSpec.name, exact: locatorSpec.exact !== false });
    descriptor = { strategy: "role", role: locatorSpec.role, name: locatorSpec.name, exact: locatorSpec.exact !== false };
  } else if (locatorSpec.strategy === "text") {
    if (!locatorSpec.text) throw new Error("Text locators require text.");
    locator = page.getByText(locatorSpec.text, { exact: locatorSpec.exact !== false });
    descriptor = { strategy: "text", text: locatorSpec.text, exact: locatorSpec.exact !== false };
  } else if (locatorSpec.strategy === "css") {
    if (!locatorSpec.selector) throw new Error("CSS locators require selector.");
    locator = page.locator(locatorSpec.selector);
    descriptor = { strategy: "css", selector: locatorSpec.selector };
  } else {
    throw new Error("Locator strategy must be role, text, or css.");
  }

  const count = await locator.count();
  if (count !== 1) throw new Error(`Deterministic locator must match exactly one element; matched ${count}.`);

  const matched = await locator.evaluate((element) => ({
    tag: element.tagName.toLowerCase(),
    text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
    ariaLabel: element.getAttribute("aria-label"),
  }));
  return { locator, descriptor: { ...descriptor, matched } };
}

async function performAction(page, action, timeoutMs) {
  const { locator, descriptor } = await resolveUniqueLocator(page, action.locator);
  if (action.type === "click") {
    await locator.click({ timeout: Math.min(7_500, timeoutMs) });
  } else if (action.type === "fill") {
    if (typeof action.value !== "string") throw new Error("Fill actions require a string value.");
    await locator.fill(action.value, { timeout: Math.min(7_500, timeoutMs) });
  } else if (action.type === "scroll_into_view") {
    await locator.scrollIntoViewIfNeeded({ timeout: Math.min(7_500, timeoutMs) });
  } else {
    throw new Error("Action type must be click, fill, or scroll_into_view.");
  }
  return descriptor;
}

async function measureLocator(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      rect: {
        top: Math.round(rect.top * 10) / 10,
        bottom: Math.round(rect.bottom * 10) / 10,
        left: Math.round(rect.left * 10) / 10,
        right: Math.round(rect.right * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
      },
      centerOffsetPx: Math.round((rect.top + rect.height / 2 - innerHeight / 2) * 10) / 10,
      viewportHeight: innerHeight,
      scrollY: Math.round(scrollY),
    };
  });
}

async function performScrollCheckpoint(page, checkpoint) {
  if (checkpoint.kind === "progress") {
    if (typeof checkpoint.progress !== "number" || checkpoint.progress < 0 || checkpoint.progress > 1) {
      throw new Error("Scroll progress checkpoints require progress between 0 and 1.");
    }
    const result = await page.evaluate((progress) => {
      const root = document.documentElement;
      const body = document.body;
      const scrollHeight = Math.max(root.scrollHeight, body?.scrollHeight || 0);
      const maxY = Math.max(0, scrollHeight - innerHeight);
      const targetY = Math.round(maxY * progress);
      window.scrollTo(0, targetY);
      return { requestedProgress: progress, targetY, maxY };
    }, checkpoint.progress);
    return { ...result, kind: "progress", resolvedLocator: null, measurement: null };
  }

  if (checkpoint.kind === "element" || checkpoint.kind === "measure") {
    const { locator, descriptor } = await resolveUniqueLocator(page, checkpoint.locator);
    if (checkpoint.kind === "element") {
      const align = checkpoint.align || "center";
      if (!["start", "center", "end"].includes(align)) throw new Error("Element scroll align must be start, center, or end.");
      await locator.evaluate((element, requestedAlign) => {
        const rect = element.getBoundingClientRect();
        let target = scrollY + rect.top;
        if (requestedAlign === "center") target -= (innerHeight - rect.height) / 2;
        if (requestedAlign === "end") target -= innerHeight - rect.height;
        window.scrollTo(0, Math.max(0, target));
      }, align);
    }
    return {
      kind: checkpoint.kind,
      align: checkpoint.kind === "element" ? checkpoint.align || "center" : null,
      resolvedLocator: descriptor,
      measurement: await measureLocator(locator),
    };
  }

  throw new Error("Scroll checkpoint kind must be progress, element, or measure.");
}

export class BrowserRunner {
  constructor({ allowPrivateTargets = false, loadPlaywright } = {}) {
    this.allowPrivateTargets = allowPrivateTargets;
    this.loadPlaywright = loadPlaywright ?? (() => import("playwright"));
  }

  async #withPage({ url, viewport, timeoutMs }, fn) {
    const safeUrl = await assertSafeHttpUrl(url, { allowPrivate: this.allowPrivateTargets });
    const { chromium } = await this.loadPlaywright();
    const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: "block" });
    const consoleErrors = [];
    const networkErrors = [];
    try {
      await installSafeRouting(context, { allowPrivateTargets: this.allowPrivateTargets, networkErrors });
      const page = await context.newPage();
      installDiagnostics(page, { consoleErrors, networkErrors });
      await page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await settlePage(page, timeoutMs);
      return await fn(page, { consoleErrors, networkErrors });
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  async capture({ url, viewport = { width: 1440, height: 900 }, timeoutMs = 30_000 }) {
    return this.#withPage({ url, viewport, timeoutMs }, async (page, diagnostics) => snapshotPage(page, diagnostics));
  }

  async runAction({ url, viewport = { width: 1440, height: 900 }, action, timeoutMs = 30_000 }) {
    if (!action?.type || !action?.locator) throw new Error("A deterministic action and locator are required.");
    return this.#withPage({ url, viewport, timeoutMs }, async (page, diagnostics) => {
      const before = await snapshotPage(page, diagnostics);
      const resolvedLocator = await performAction(page, action, timeoutMs);
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.min(3_000, timeoutMs) });
      } catch {
        // SPA actions often do not navigate.
      }
      await settlePage(page, Math.min(3_000, timeoutMs));
      const after = await snapshotPage(page, diagnostics);
      return { before, after, resolvedLocator };
    });
  }

  async runScrollCheckpoints({ url, viewport = { width: 1440, height: 900 }, checkpoints, timeoutMs = 30_000 }) {
    if (!Array.isArray(checkpoints) || !checkpoints.length || checkpoints.length > 20) {
      throw new Error("Scroll review requires between 1 and 20 checkpoints.");
    }
    return this.#withPage({ url, viewport, timeoutMs }, async (page, diagnostics) => {
      const steps = [];
      for (let index = 0; index < checkpoints.length; index += 1) {
        const checkpoint = checkpoints[index];
        const result = await performScrollCheckpoint(page, checkpoint);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (result.resolvedLocator && result.measurement) {
          const { locator } = await resolveUniqueLocator(page, checkpoint.locator);
          result.measurement = await measureLocator(locator);
        }
        const capture = await snapshotPage(page, diagnostics);
        steps.push({ index, checkpoint, result, capture });
      }
      return steps;
    });
  }
}