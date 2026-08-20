const INTERACTIVE_TAGS = new Set(["button", "a", "input", "select", "textarea", "summary"]);

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(value) {
  return [...new Set(normalize(value).split(/\s+/).filter((token) => token.length >= 2))];
}

function nativeRole(element) {
  if (element.role) return element.role;
  if (element.tag === "button") return "button";
  if (element.tag === "textarea") return "textbox";
  if (element.tag === "select") return "combobox";
  if (element.tag === "input") return "textbox";
  return null;
}

function scoreElement(element, hintTokens) {
  const name = normalize(element.name);
  const text = normalize(element.text);
  const selector = normalize(element.selector);
  const path = normalize(element.path);
  let score = INTERACTIVE_TAGS.has(element.tag) || element.role ? 1 : 0;
  for (const token of hintTokens) {
    if (name.includes(token)) score += 5;
    if (text.includes(token)) score += 4;
    if (selector.includes(token)) score += 2;
    if (path.includes(token)) score += 1;
  }
  return score;
}

function locatorOptions(element) {
  const options = [];
  const role = nativeRole(element);
  if (role && element.name) options.push({ strategy: "role", role, name: element.name, exact: true });
  if (element.text) options.push({ strategy: "text", text: element.text, exact: true });
  if (element.path) options.push({ strategy: "css", selector: element.path });
  else if (element.selector) options.push({ strategy: "css", selector: element.selector });
  return options.slice(0, 3);
}

export function buildRecoveryCandidates(evidence, targetHint = "", maxCandidates = 12) {
  const structure = Array.isArray(evidence?.structure) ? evidence.structure : [];
  const hintTokens = tokens(targetHint);
  return structure
    .map((element, index) => ({ element, index, score: scoreElement(element, hintTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.element.rect.top - b.element.rect.top || a.index - b.index)
    .slice(0, Math.max(1, Math.min(30, maxCandidates)))
    .map((item, rank) => ({
      rank: rank + 1,
      score: item.score,
      tag: item.element.tag,
      role: nativeRole(item.element),
      name: item.element.name,
      text: item.element.text,
      selector: item.element.selector,
      path: item.element.path,
      rect: item.element.rect,
      locator_options: locatorOptions(item.element),
    }));
}