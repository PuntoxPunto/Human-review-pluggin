import test from "node:test";
import assert from "node:assert/strict";
import { buildRecoveryCandidates } from "../src/web-review/recovery.js";
import { RecoveryRecipeStore } from "../src/web-review/recovery-store.js";

const rect = { x: 0, y: 0, width: 100, height: 40, top: 0, right: 100, bottom: 40, left: 0 };

function element(overrides) {
  return {
    tag: "div",
    selector: "div",
    path: "main > div",
    parentPath: "main",
    role: null,
    name: null,
    text: null,
    rect,
    position: "static",
    zIndex: "auto",
    overflowX: "visible",
    overflowY: "visible",
    ...overrides,
  };
}

test("recovery context ranks semantically matching interactive evidence first", () => {
  const evidence = {
    structure: [
      element({ tag: "p", selector: "p", path: "main > p", text: "General information", name: "General information" }),
      element({ tag: "button", selector: "button#secondary", path: "main > button:nth-of-type(2)", text: "Continue", name: "Secondary action" }),
      element({ tag: "button", selector: "button#primary", path: "main > button:nth-of-type(1)", text: "Continue", name: "Primary action" }),
    ],
  };

  const candidates = buildRecoveryCandidates(evidence, "primary action", 3);
  assert.equal(candidates[0].selector, "button#primary");
  assert.equal(candidates[0].role, "button");
  assert.deepEqual(candidates[0].locator_options[0], {
    strategy: "role",
    role: "button",
    name: "Primary action",
    exact: true,
  });
  assert.ok(candidates[0].score > candidates[1].score);
});

test("recovery ranking normalizes accented Portuguese hints", () => {
  const evidence = {
    structure: [
      element({ tag: "button", selector: "button#acao", path: "main > button", text: "Continuar", name: "Ação principal" }),
      element({ tag: "button", selector: "button#other", path: "main > button:nth-of-type(2)", text: "Voltar", name: "Outra opção" }),
    ],
  };
  const candidates = buildRecoveryCandidates(evidence, "acao principal", 2);
  assert.equal(candidates[0].selector, "button#acao");
});

test("verified recovery recipe keeps identity and increments verification count", () => {
  const store = new RecoveryRecipeStore();
  const base = {
    reviewId: "webrev_1",
    targetUrl: "https://example.com/",
    targetHint: "primary action",
    failedLocator: { strategy: "text", text: "Continue", exact: true },
    verifiedLocator: { strategy: "role", role: "button", name: "Primary action", exact: true },
    resolvedLocator: { strategy: "role", role: "button", name: "Primary action", exact: true, matched: { tag: "button" } },
  };

  const first = store.save({ ...base, evidenceId: "ev_1" });
  const second = store.save({ ...base, evidenceId: "ev_2" });
  assert.equal(second.id, first.id);
  assert.equal(second.verificationCount, 2);
  assert.equal(second.evidenceId, "ev_2");

  const distinct = store.save({ ...base, targetHint: "secondary action", evidenceId: "ev_3" });
  assert.notEqual(distinct.id, first.id);
  assert.equal(store.list("webrev_1").length, 2);
});