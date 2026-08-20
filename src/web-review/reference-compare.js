function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function textOf(element) {
  return String(element?.text || "").trim();
}

function rectDelta(referenceRect, candidateRect) {
  return {
    dx: round(candidateRect.left - referenceRect.left),
    dy: round(candidateRect.top - referenceRect.top),
    dw: round(candidateRect.width - referenceRect.width),
    dh: round(candidateRect.height - referenceRect.height),
  };
}

function isMaterial(delta, textChanged) {
  return textChanged || Math.abs(delta.dx) > 2 || Math.abs(delta.dy) > 2 || Math.abs(delta.dw) > 2 || Math.abs(delta.dh) > 2;
}

function identity(element) {
  return element.path || element.selector;
}

export function compareEvidence(reference, candidate, { maxDeltas = 80 } = {}) {
  if (reference.viewport.width !== candidate.viewport.width || reference.viewport.height !== candidate.viewport.height) {
    throw new Error(`Reference comparison requires identical viewports; reference is ${reference.viewport.width}x${reference.viewport.height}, candidate is ${candidate.viewport.width}x${candidate.viewport.height}.`);
  }

  const referenceByPath = new Map(reference.structure.map((element) => [identity(element), element]));
  const candidateByPath = new Map(candidate.structure.map((element) => [identity(element), element]));
  const added = [];
  const removed = [];
  const changed = [];
  let matched = 0;

  for (const [path, referenceElement] of referenceByPath) {
    const candidateElement = candidateByPath.get(path);
    if (!candidateElement) {
      removed.push({ path, tag: referenceElement.tag, name: referenceElement.name, text: textOf(referenceElement), rect: referenceElement.rect });
      continue;
    }
    matched += 1;
    const delta = rectDelta(referenceElement.rect, candidateElement.rect);
    const textChanged = textOf(referenceElement) !== textOf(candidateElement);
    if (isMaterial(delta, textChanged)) {
      changed.push({
        path,
        selector: candidateElement.selector,
        tag: candidateElement.tag,
        name: candidateElement.name,
        reference_rect: referenceElement.rect,
        candidate_rect: candidateElement.rect,
        delta,
        text_changed: textChanged,
        reference_text: textOf(referenceElement).slice(0, 500),
        candidate_text: textOf(candidateElement).slice(0, 500),
      });
    }
  }

  for (const [path, candidateElement] of candidateByPath) {
    if (referenceByPath.has(path)) continue;
    added.push({ path, tag: candidateElement.tag, name: candidateElement.name, text: textOf(candidateElement), rect: candidateElement.rect });
  }

  changed.sort((a, b) => {
    const aMagnitude = Math.abs(a.delta.dx) + Math.abs(a.delta.dy) + Math.abs(a.delta.dw) + Math.abs(a.delta.dh) + (a.text_changed ? 1000 : 0);
    const bMagnitude = Math.abs(b.delta.dx) + Math.abs(b.delta.dy) + Math.abs(b.delta.dw) + Math.abs(b.delta.dh) + (b.text_changed ? 1000 : 0);
    return bMagnitude - aMagnitude;
  });

  return {
    viewport: reference.viewport,
    reference: {
      evidenceId: reference.id,
      reviewId: reference.reviewId,
      url: reference.finalUrl,
      scroll: reference.scroll,
      document: reference.document,
      structureCount: reference.structure.length,
    },
    candidate: {
      evidenceId: candidate.id,
      reviewId: candidate.reviewId,
      url: candidate.finalUrl,
      scroll: candidate.scroll,
      document: candidate.document,
      structureCount: candidate.structure.length,
    },
    metrics: {
      matched,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      scroll_dx: round(candidate.scroll.x - reference.scroll.x),
      scroll_dy: round(candidate.scroll.y - reference.scroll.y),
      document_width_delta: round(candidate.document.scrollWidth - reference.document.scrollWidth),
      document_height_delta: round(candidate.document.scrollHeight - reference.document.scrollHeight),
    },
    added: added.slice(0, maxDeltas),
    removed: removed.slice(0, maxDeltas),
    changed: changed.slice(0, maxDeltas),
  };
}
