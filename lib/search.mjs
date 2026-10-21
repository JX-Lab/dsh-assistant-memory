// Retrieval layer: tokenization + hybrid scoring.
//
// No embeddings are available offline, so this is deliberately lexical:
// CJK bigrams + latin words, IDF-weighted coverage of the query, then a few
// cheap signals (recency, importance, pin, usage, scope/kind match).
// It is meant for a store of tens to thousands of short records, where a full
// scan is faster than any index.

import { isExpired, daysBetween, recordTime } from "./store.mjs";

const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;
const LATIN_WORD = /[a-z0-9][a-z0-9_+.#-]+/g;

export function normalize(text) {
  return String(text ?? "").normalize("NFKC").toLowerCase();
}

/**
 * Tokens for matching. CJK is split into character bigrams (single-character
 * runs kept as-is) because there is no segmenter here; latin text into words
 * of length >= 2. Punctuation never becomes a token.
 */
export function tokenize(text) {
  const source = normalize(text);
  const out = new Set();
  for (const match of source.matchAll(LATIN_WORD)) out.add(match[0]);
  for (const match of source.matchAll(CJK_RUN)) {
    const run = match[0];
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return [...out];
}

/** Jaccard similarity of two texts, used for duplicate detection. */
export function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

function compactForCompare(text) {
  return normalize(text).replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Decide whether a new statement duplicates an existing one.
 *
 * Merging blindly on similarity is dangerous: "部署在 us-east-1" and
 * "部署在 us-west-2" are lexically close but contradict each other, and the
 * right move there is `--supersedes`, not a merge. So auto-merge only when
 * one text *contains* the other (an elaboration, e.g. a clause appended) or
 * the wording is all but identical. Anything in between is reported as a
 * candidate for the caller to resolve.
 */
export function duplicateDecision(newText, candidateText, options = {}) {
  const mergeAt = options.mergeAt ?? 0.93;
  const hintAt = options.hintAt ?? 0.7;
  const sim = similarity(newText, candidateText);
  const left = compactForCompare(newText);
  const right = compactForCompare(candidateText);
  const contains = left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left));
  const merge = (contains && sim >= 0.6) || sim >= mergeAt;
  return {
    similarity: sim,
    contains,
    exact: left === right,
    merge,
    hint: !merge && sim >= hintAt,
  };
}

function buildIdf(records) {
  const df = new Map();
  for (const record of records) {
    for (const token of new Set(tokenize(recordSearchText(record)))) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }
  const total = records.length;
  return (token) => {
    const seen = df.get(token) || 0;
    return Math.log((total + 1) / (seen + 0.5)) + 1;
  };
}

export function recordSearchText(record) {
  const tags = Array.isArray(record.tags) ? record.tags.join(" ") : "";
  const aliases = Array.isArray(record.aliases) ? record.aliases.join(" ") : "";
  return `${record.text || ""} ${tags} ${aliases}`.trim();
}

function recencyBoost(record, nowMs, halfLifeDays = 120) {
  const age = daysBetween(recordTime(record), nowMs);
  return Math.exp(-age / Math.max(1, halfLifeDays));
}

function usageBoost(record) {
  return Math.log1p(record.uses || 0) / 3;
}

/**
 * Rank active, non-expired records.
 *
 * opts:
 *   now, scope, kind, limit, query
 *   gate: minimum lexical coverage to surface a record (default 0.2)
 *   sinceMs / untilMs: keep records whose event time falls in this window
 *   asOfMs: answer "what was believed at that moment". Superseded records stay
 *           eligible until their successor took effect, so a query about March
 *           can return the answer that was true in March.
 *   halfLifeDays: recency decay
 */
export function rank(records, query, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const limit = opts.limit ?? 8;
  const gate = typeof opts.gate === "number" ? opts.gate : 0.2;
  const halfLifeDays = opts.halfLifeDays ?? 120;
  const asOf = Number.isFinite(opts.asOfMs) ? opts.asOfMs : null;
  const queryText = normalize(query || "");
  const queryTokens = tokenize(queryText);
  const hasQuery = queryText.trim().length > 0;

  // Valid-until for a superseded record is the moment its successor took
  // effect, which keeps the history queryable without a second timestamp.
  const byId = new Map(records.map((r) => [r.id, r]));
  const validUntil = new Map();
  for (const record of records) {
    if (!record.superseded_by) continue;
    const successor = byId.get(record.superseded_by);
    if (successor) {
      const at = Date.parse(recordTime(successor));
      if (Number.isFinite(at)) validUntil.set(record.id, at);
    }
  }

  const pool = records.filter((record) => {
    if (asOf === null) {
      if (record.status !== "active") return false;
    } else {
      if (record.status === "archived") return false;
      const from = Date.parse(recordTime(record));
      if (!Number.isFinite(from) || from > asOf) return false;
      if (record.status === "superseded") {
        const until = validUntil.get(record.id);
        if (Number.isFinite(until) && until <= asOf) return false;
      }
    }
    if (isExpired(record, nowMs)) return false;
    if (opts.scope && record.scope !== opts.scope) return false;
    if (opts.kind && record.kind !== opts.kind) return false;
    if (opts.sinceMs || opts.untilMs) {
      const at = Date.parse(recordTime(record));
      if (!Number.isFinite(at)) return false;
      if (opts.sinceMs && at < opts.sinceMs) return false;
      if (opts.untilMs && at > opts.untilMs) return false;
    }
    return true;
  });

  const idf = buildIdf(pool);
  const querySet = new Set(queryTokens);
  let queryWeight = 0;
  for (const token of querySet) queryWeight += idf(token);

  const scored = [];
  for (const record of pool) {
    const docTokens = new Set(tokenize(recordSearchText(record)));
    let matchedWeight = 0;
    for (const token of querySet) {
      if (docTokens.has(token)) matchedWeight += idf(token);
    }
    const coverage = queryWeight > 0 ? matchedWeight / queryWeight : 0;
    const exact = hasQuery && queryText.length >= 2 && normalize(record.text).includes(queryText);

    if (hasQuery && coverage < gate && !exact) continue;

    const scopeBonus = opts.scope && record.scope === opts.scope ? 0.1 : 0;
    const kindBonus = opts.kind && record.kind === opts.kind ? 0.05 : 0;

    const score = hasQuery
      ? 2 * coverage +
        (exact ? 0.5 : 0) +
        0.2 * recencyBoost(record, nowMs, halfLifeDays) +
        0.15 * ((record.importance || 3) / 5) +
        0.05 * usageBoost(record) +
        scopeBonus +
        kindBonus +
        (record.pinned ? 0.15 : 0)
      : (record.pinned ? 3 : 0) +
        1.2 * ((record.importance || 3) / 5) +
        0.8 * recencyBoost(record, nowMs, halfLifeDays) +
        0.2 * usageBoost(record) +
        scopeBonus +
        kindBonus;

    scored.push({ record, score, coverage, exact });
  }

  scored.sort((a, b) => b.score - a.score || String(b.record.updated_at).localeCompare(String(a.record.updated_at)));
  return scored.slice(0, limit);
}

/**
 * Fit ranked results into a character budget by dropping the weakest tail.
 * Pinned records are never dropped while anything else remains.
 */
export function fitBudget(items, render, budget) {
  if (!budget || budget <= 0) return items;
  let kept = [...items];
  while (kept.length && render(kept).length > budget) {
    let dropIndex = -1;
    for (let i = kept.length - 1; i >= 0; i -= 1) {
      if (!kept[i].record?.pinned) {
        dropIndex = i;
        break;
      }
    }
    if (dropIndex === -1) break;
    kept = kept.filter((_, index) => index !== dropIndex);
  }
  return kept;
}
