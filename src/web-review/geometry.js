function intersectionRect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top };
}

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function isAncestorPath(parent, child) {
  return Boolean(parent && child && child.startsWith(`${parent} > `));
}

function targetFrom(element) {
  return {
    selector: element.selector,
    path: element.path,
    tag: element.tag,
    name: element.name,
    rect: element.rect,
  };
}

const CONTENT_TAGS = new Set([
  "a", "button", "input", "textarea", "select", "img", "svg", "figure",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "li", "article", "section",
]);

function isOverlapCandidate(element, viewport) {
  const rectArea = area(element.rect);
  const viewportArea = viewport.width * viewport.height;
  if (rectArea < 64 || rectArea > viewportArea * 0.75) return false;
  if (CONTENT_TAGS.has(element.tag)) return true;
  if (element.role) return true;
  if (element.text && element.text.length > 0 && element.text.length <= 240) return true;
  return /card|cta|button|item|tile|panel|badge|timeline|step/i.test(element.selector || "");
}

export function analyzeGeometry(evidence) {
  const findings = [];
  const viewport = evidence.viewport;
  const documentMetrics = evidence.document || {
    scrollWidth: viewport.width,
    scrollHeight: viewport.height,
    clientWidth: viewport.width,
    clientHeight: viewport.height,
  };

  const horizontalOverflow = Math.max(0, documentMetrics.scrollWidth - viewport.width);
  if (horizontalOverflow > 1) {
    findings.push({
      type: "horizontal_overflow",
      severity: horizontalOverflow > 24 ? "error" : "warning",
      confidence: 0.99,
      title: "Page exceeds viewport width",
      description: `Document is ${Math.round(horizontalOverflow)}px wider than the ${viewport.width}px viewport.`,
      target: null,
      related: null,
      rect: { x: viewport.width, y: 0, left: viewport.width, top: 0, right: documentMetrics.scrollWidth, bottom: viewport.height, width: horizontalOverflow, height: viewport.height },
      metrics: { overflow_px: Math.round(horizontalOverflow), scroll_width: documentMetrics.scrollWidth, viewport_width: viewport.width },
    });
  }

  for (const element of evidence.structure) {
    const leftOverflow = Math.max(0, -element.rect.left);
    const rightOverflow = Math.max(0, element.rect.right - viewport.width);
    const overflow = Math.max(leftOverflow, rightOverflow);
    if (overflow <= 2) continue;
    findings.push({
      type: "element_horizontal_clipping",
      severity: overflow > 24 ? "error" : "warning",
      confidence: 0.92,
      title: "Visible element crosses viewport edge",
      description: `${element.selector} extends ${Math.round(overflow)}px beyond the horizontal viewport.`,
      target: targetFrom(element),
      related: null,
      rect: element.rect,
      metrics: { overflow_px: Math.round(overflow) },
    });
    if (findings.length >= 80) break;
  }

  const candidates = evidence.structure.filter((element) => isOverlapCandidate(element, viewport));
  for (let i = 0; i < candidates.length && findings.length < 80; i += 1) {
    const a = candidates[i];
    for (let j = i + 1; j < candidates.length && findings.length < 80; j += 1) {
      const b = candidates[j];
      if (a.path === b.path || isAncestorPath(a.path, b.path) || isAncestorPath(b.path, a.path)) continue;
      const intersection = intersectionRect(a.rect, b.rect);
      if (!intersection || intersection.width < 8 || intersection.height < 8) continue;
      const smallerArea = Math.min(area(a.rect), area(b.rect));
      if (smallerArea <= 0) continue;
      const ratio = area(intersection) / smallerArea;
      if (ratio < 0.12) continue;
      findings.push({
        type: "candidate_overlap",
        severity: ratio > 0.5 ? "warning" : "info",
        confidence: Math.min(0.78, 0.45 + ratio * 0.35),
        title: "Possible unintended overlap",
        description: `${a.selector} and ${b.selector} overlap across ${Math.round(ratio * 100)}% of the smaller element.`,
        target: targetFrom(a),
        related: targetFrom(b),
        rect: intersection,
        metrics: { overlap_ratio: Math.round(ratio * 1000) / 1000, intersection_area: Math.round(area(intersection)) },
      });
    }
  }

  return findings;
}
