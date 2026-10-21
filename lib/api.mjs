// The memory engine: everything the CLI used to do, minus argument parsing.
// The tool layer calls these functions directly, so nothing here spawns
// processes or touches a shell.

import {
  ROOT,
  KINDS,
  pathsFor,
  createRecord,
  patchRecord,
  readStore,
  withStore,
  findRecord,
  shortId,
  nowIso,
  isExpired,
  loadConfig,
  recordTime,
} from "./store.mjs";
import { rank, duplicateDecision, fitBudget } from "./search.mjs";

const DAY_MS = 86_400_000;

const SECRET_PATTERNS = [
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "OpenAI 风格密钥", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "AWS 访问密钥", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub 令牌", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "带密码的连接串", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: "口令赋值", re: /(?:password|passwd|pwd|secret|token|密码|口令|密钥)\s*[:=：]\s*\S{3,}/i },
  { name: "身份证号", re: /\b\d{17}[\dXx]\b/ },
  { name: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
];

function detectSensitive(text) {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

function parseTags(value) {
  if (!value) return [];
  return String(value)
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function requireText(text) {
  const value = String(text ?? "").trim();
  if (!value) throw new Error("缺少记忆内容（text）");
  return value;
}

export async function remember(input = {}, base = ROOT) {
  const text = requireText(input.text);
  const sensitive = detectSensitive(text);
  if (sensitive.length && !input.allowSensitive) {
    throw new Error(`内容疑似包含敏感信息（${sensitive.join("、")}），已拒绝写入`);
  }

  const config = await loadConfig(base);
  const kind = KINDS.includes(input.kind) ? input.kind : "fact";
  const scope = ["user", "project", "workspace", "session"].includes(input.scope)
    ? input.scope
    : "user";
  const key = input.key ? String(input.key).trim() : null;
  if (key && /\s/.test(key)) throw new Error("key 不能含空格，用「对象.方面」形式");

  const aliases = parseTags(input.aliases);
  const observed = input.observed ? new Date(input.observed).toISOString() : null;
  const source = input.source ?? null;

  return withStore(async (records) => {
    const now = new Date();

    const limit = config.write.maxPerDay;
    if (limit > 0 && !input.force) {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const today = records.filter((r) => Date.parse(r.created_at) >= start.getTime()).length;
      if (today >= limit) {
        throw new Error(`今天已记 ${today} 条，达到上限 ${limit}（config.json 的 write.maxPerDay）`);
      }
    }

    let superseded = null;
    if (input.supersedes) {
      const found = findRecord(records, input.supersedes);
      if (!found.record) throw new Error(`找不到要取代的记忆: ${input.supersedes}`);
      superseded = found.record;
    }
    if (key) {
      const sameKey = records.find(
        (r) =>
          r.status === "active" &&
          r.scope === scope &&
          r.key &&
          r.key.toLowerCase() === key.toLowerCase(),
      );
      if (sameKey && (!superseded || superseded.id === sameKey.id)) superseded = sameKey;
    }

    const candidates = records.filter(
      (r) => r.status === "active" && r.scope === scope && r.id !== superseded?.id,
    );
    let duplicate = null;
    let best = { similarity: 0, merge: false, hint: false, exact: false };
    for (const candidate of candidates) {
      const decision = duplicateDecision(text, candidate.text, config.dedupe);
      if (decision.similarity > best.similarity) {
        best = decision;
        duplicate = candidate;
      }
    }

    if (duplicate && best.exact && !superseded) {
      return {
        write: false,
        payload: { action: "unchanged", record: duplicate, similarity: 1, similar_to: null },
      };
    }

    const shouldMerge = Boolean(!superseded && duplicate && best.merge && !input.noMerge);
    let action;
    let record;

    if (shouldMerge) {
      const patch = {
        confidence: Math.max(duplicate.confidence, Number(input.confidence) || duplicate.confidence),
        importance: Math.max(duplicate.importance, Number(input.importance) || duplicate.importance),
        tags: [...new Set([...duplicate.tags, ...parseTags(input.tags)])],
        aliases: [...new Set([...(duplicate.aliases || []), ...aliases])],
        pinned: duplicate.pinned || Boolean(input.pin),
      };
      if (text.length > duplicate.text.length) patch.text = text;
      if (observed) patch.observed_at = observed;
      if (key) patch.key = key;
      Object.assign(duplicate, patchRecord(duplicate, patch, now));
      record = duplicate;
      action = "merged";
    } else {
      record = createRecord(
        {
          text,
          kind,
          scope,
          key,
          aliases,
          confidence: input.confidence,
          importance: input.importance,
          pinned: Boolean(input.pin),
          tags: parseTags(input.tags),
          observed_at: observed,
          sensitive: sensitive.length > 0,
          source,
        },
        now,
      );
      if (superseded) {
        record.supersedes = superseded.id;
        superseded.status = "superseded";
        superseded.superseded_by = record.id;
        superseded.updated_at = nowIso(now);
      }
      records.push(record);
      action = superseded ? "superseded" : "created";
    }

    return {
      write: true,
      payload: {
        action,
        record,
        similarity: Number(best.similarity.toFixed(3)),
        similar_to:
          action !== "merged" && duplicate && best.hint
            ? { id: duplicate.id, similarity: Number(best.similarity.toFixed(3)), text: duplicate.text }
            : null,
      },
    };
  }, base).then((result) => result.payload);
}

export async function recall(input = {}, base = ROOT) {
  const config = await loadConfig(base);
  const query = String(input.query ?? "");
  const limit = Number(input.limit) || config.recall.limit;
  const budget = input.budget ? Number(input.budget) : 0;
  const scope = input.scope;
  const kind = input.kind;
  const touch = input.touch !== false;

  const result = await withStore(async (records) => {
    const now = Date.now();
    const ranked = rank(records, query, {
      limit,
      scope,
      kind,
      now,
      gate: config.recall.gate,
      halfLifeDays: config.recall.halfLifeDays,
    });
    const fitted = fitBudget(ranked, (items) => items.map((i) => i.record.text).join("\n"), budget);
    if (fitted.length && touch) {
      for (const item of fitted) {
        item.record.uses = (item.record.uses || 0) + 1;
        item.record.last_used_at = nowIso();
      }
    }
    return { write: fitted.length > 0 && touch, payload: fitted };
  }, base);

  return result.payload.map((item) => ({
    id: item.record.id,
    shortId: shortId(item.record.id),
    text: item.record.text,
    kind: item.record.kind,
    scope: item.record.scope,
    score: Number(item.score.toFixed(3)),
    importance: item.record.importance,
  }));
}

export async function brief(input = {}, base = ROOT) {
  const config = await loadConfig(base);
  const query = String(input.query ?? "");
  const budget = input.budget ? Number(input.budget) : config.recall.budget;
  const { records, errors } = await readStore(base);
  if (errors.length) throw new Error(`记忆库有 ${errors.length} 行无法解析，请检查 ${pathsFor(base).data}`);

  const active = records.filter((r) => r.status === "active" && !isExpired(r));
  if (!active.length) return "记忆库还是空的。";

  const ranked = rank(records, query, {
    limit: 40,
    gate: config.recall.gate,
    halfLifeDays: config.recall.halfLifeDays,
  });
  const pinned = ranked.filter((i) => i.record.pinned);
  const rest = ranked.filter((i) => !i.record.pinned);
  const line = (r) => `- [${shortId(r.id)}] ${r.text}`;
  const chosen = fitBudget(rest, (items) => items.map((i) => line(i.record)).join("\n"), Math.max(200, budget - pinned.length * 60));

  const lines = [`# 记忆摘要（生效 ${active.length} 条${query ? `，查询: ${query}` : ""}）`];
  if (pinned.length) lines.push("", "## 置顶", ...pinned.map((i) => line(i.record)));
  if (chosen.length) lines.push("", "## 相关", ...chosen.map((i) => line(i.record)));
  return lines.join("\n");
}

export async function list(input = {}, base = ROOT) {
  const { records } = await readStore(base);
  const status = input.status || "active";
  let subset = records.filter((r) => (status === "all" ? true : r.status === status));
  if (input.scope) subset = subset.filter((r) => r.scope === input.scope);
  if (input.kind) subset = subset.filter((r) => r.kind === input.kind);
  subset.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return subset.map((r) => ({
    id: r.id,
    shortId: shortId(r.id),
    text: r.text,
    kind: r.kind,
    scope: r.scope,
    status: r.status,
    key: r.key,
    importance: r.importance,
    updatedAt: r.updated_at,
    observedAt: recordTime(r),
  }));
}

export async function forget(input = {}, base = ROOT) {
  const id = String(input.id ?? "").trim();
  if (!id) throw new Error("缺少 id");
  const result = await withStore(async (records) => {
    const found = findRecord(records, id);
    if (!found.record) throw new Error(`找不到记忆: ${id}`);
    if (input.hard) {
      records.splice(records.indexOf(found.record), 1);
      return { payload: { action: "deleted", id: found.record.id, text: found.record.text } };
    }
    found.record.status = "archived";
    found.record.updated_at = nowIso();
    return { payload: { action: "archived", id: found.record.id, text: found.record.text } };
  }, base);
  return result.payload;
}

export async function stats(base = ROOT) {
  const { records, errors, bytes } = await readStore(base);
  const active = records.filter((r) => r.status === "active");
  return {
    file: pathsFor(base).data,
    bytes,
    total: records.length,
    active: active.length,
    pinned: active.filter((r) => r.pinned).length,
    expired: active.filter((r) => isExpired(r)).length,
    byKind: active.reduce((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] || 0) + 1 }), {}),
    parseErrors: errors.length,
    days: Math.round((Date.now() - Date.parse(active[0]?.created_at ?? Date.now())) / DAY_MS),
  };
}
