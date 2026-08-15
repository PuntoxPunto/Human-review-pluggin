const MAX_HTML_BYTES = 2 * 1024 * 1024;

const BLOCKED_TAGS = ["script", "iframe", "object", "embed", "base", "portal"];

function stripBlockedTags(html) {
  let out = html;
  for (const tag of BLOCKED_TAGS) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi");
    const single = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    out = out.replace(paired, "").replace(single, "");
  }
  return out;
}

export function sanitizeReviewHtml(input) {
  let html = String(input ?? "");
  if (!html.trim()) throw new Error("HTML cannot be empty.");
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) {
    throw new Error("HTML is larger than the 2 MB MVP limit.");
  }

  html = stripBlockedTags(html)
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>/gi, "")
    .replace(/<link\b[^>]*rel\s*=\s*(?:"(?:preload|prefetch|modulepreload|stylesheet)"|'(?:preload|prefetch|modulepreload|stylesheet)'|(?:preload|prefetch|modulepreload|stylesheet))[^>]*>/gi, "")
    .replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(src|href|action|formaction)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=$2#$2")
    .replace(/\s(src|href)\s*=\s*(["'])\s*data:text\/html[\s\S]*?\2/gi, " $1=$2#$2");

  if (!/^\s*<!doctype\s+html/i.test(html)) html = `<!doctype html>\n${html}`;
  return html;
}

export function stripTags(input) {
  return String(input ?? "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}
