import test from "node:test";
import assert from "node:assert/strict";
import { analyzeGeometry } from "../src/web-review/geometry.js";

function element({ tag = "div", selector, path, parentPath = "body", text = "", rect, role = null }) {
  return {
    tag,
    selector,
    path,
    parentPath,
    role,
    name: text || null,
    text: text || null,
    rect,
    position: "static",
    zIndex: "auto",
    overflowX: "visible",
    overflowY: "visible",
  };
}

function evidence(structure = [], overrides = {}) {
  return {
    viewport: { width: 1000, height: 800 },
    document: { scrollWidth: 1000, scrollHeight: 1600, clientWidth: 1000, clientHeight: 800 },
    structure,
    ...overrides,
  };
}

test("detects document horizontal overflow with deterministic severity", () => {
  const findings = analyzeGeometry(evidence([], {
    document: { scrollWidth: 1035, scrollHeight: 1600, clientWidth: 1000, clientHeight: 800 },
  }));
  const finding = findings.find((item) => item.type === "horizontal_overflow");
  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.metrics.overflow_px, 35);
  assert.equal(finding.confidence, 0.99);
});

test("detects a visible element clipped beyond the horizontal viewport", () => {
  const findings = analyzeGeometry(evidence([
    element({
      tag: "button",
      selector: "button.cta",
      path: "body > button",
      text: "Continue",
      rect: { x: 970, y: 120, width: 70, height: 40, top: 120, right: 1040, bottom: 160, left: 970 },
    }),
  ]));
  const finding = findings.find((item) => item.type === "element_horizontal_clipping");
  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.metrics.overflow_px, 40);
  assert.equal(finding.target.selector, "button.cta");
});

test("reports meaningful sibling overlap as a heuristic candidate", () => {
  const findings = analyzeGeometry(evidence([
    element({
      tag: "article",
      selector: "article.card-a",
      path: "body > main > article:nth-of-type(1)",
      parentPath: "body > main",
      text: "First card",
      rect: { x: 100, y: 100, width: 260, height: 180, top: 100, right: 360, bottom: 280, left: 100 },
    }),
    element({
      tag: "article",
      selector: "article.card-b",
      path: "body > main > article:nth-of-type(2)",
      parentPath: "body > main",
      text: "Second card",
      rect: { x: 220, y: 160, width: 260, height: 180, top: 160, right: 480, bottom: 340, left: 220 },
    }),
  ]));
  const finding = findings.find((item) => item.type === "candidate_overlap");
  assert.ok(finding);
  assert.equal(finding.target.selector, "article.card-a");
  assert.equal(finding.related.selector, "article.card-b");
  assert.ok(finding.confidence < 0.8);
});

test("does not report normal parent-child containment as overlap", () => {
  const findings = analyzeGeometry(evidence([
    element({
      tag: "section",
      selector: "section.hero",
      path: "body > section",
      text: "Hero",
      rect: { x: 50, y: 50, width: 600, height: 400, top: 50, right: 650, bottom: 450, left: 50 },
    }),
    element({
      tag: "button",
      selector: "button.cta",
      path: "body > section > button",
      parentPath: "body > section",
      text: "Start",
      rect: { x: 120, y: 150, width: 160, height: 50, top: 150, right: 280, bottom: 200, left: 120 },
    }),
  ]));
  assert.equal(findings.some((item) => item.type === "candidate_overlap"), false);
});
