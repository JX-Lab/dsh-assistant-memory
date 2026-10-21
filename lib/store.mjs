// Storage layer for the assistant-memory plugin.
//
// Design goals:
// - Zero dependencies, one JSONL file, human readable and editable.
// - Every record keeps provenance (source), time, confidence, scope, TTL.
// - Updates are append-by-rewrite under a cross-process lock, committed with
//   an atomic rename so a crash never leaves a half-written store.
// - The model is the extractor: this file only stores and guards what it is
//   given. Nothing here talks to an LLM.

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Default store root: the user's DSH home, not the package directory. Plugin
 * code lives in the profile and is replaced on upgrade; memories must not.
 */
export const ROOT = path.resolve(
  process.env.DSH_MEMORY_HOME || path.join(os.homedir(), ".dsh", "memory-assistant"),
);

export const KINDS = [
  "preference", // how the user wants things done
  "fact",       // stable fact about the user or environment
  "project",    // project background, conventions, architecture
  "correction", // "no, do it this way" — highest value, never drop silently
  "decision",   // a choice that was made and why
  "person",     // people, roles, relationships
  "workflow",   // a repeatable procedure worth reusing
  "other",
];

export const SCOPES = ["user", "project", "workspace", "session"];
export const STATUSES = ["active", "superseded", "archived"];

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const DAY_MS = 86_400_000;
const MAX_TEXT = 4_000;

/** Resolve every path the store uses for one base directory. */
export function pathsFor(base = ROOT) {
  return {
    root: base,
    data: path.join(base, "memories.jsonl"),
    config: path.join(base, "config.json"),
    mirror: path.join(base, "MEMORY.md"),
    backups: path.join(base, "backups"),
    lock: path.join(base, ".lock"),
  };
}

/**
 * Behaviour knobs. Kept as data so thresholds can be inspected and tuned
 * without editing code — the same reason Baishou exposes its dedup threshold
 * as a user setting instead of a constant.
 */
export const DEFAULT_CONFIG = {
  dedupe: {
    mergeAt: 0.93, // at or above this similarity, treat as the same statement
    hintAt: 0.7, // at or above this, flag the older record for a decision
  },
  recall: {
    limit: 8,
    budget: 1200, // characters allowed into one recall/brief block
    gate: 0.2, // minimum query-term coverage to surface a memory
    halfLifeDays: 120, // recency decay half-life
  },
  write: {
    maxPerDay: 30, // 0 disables the guard; --force bypasses it once
  },
};

function clampNumber(value, fallback, min, max, path) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`config ${path} 必须是 ${min} 到 ${max} 之间的数字，收到: ${value}`);
  }
  return n;
}

function mergeConfig(raw, path = "") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config ${path || "(根)"} 必须是对象`);
  }
  const out = structuredClone(DEFAULT_CONFIG);
  const numeric = {
    "dedupe.mergeAt": [0.5, 1],
    "dedupe.hintAt": [0, 1],
    "recall.limit": [1, 50],
    "recall.budget": [0, 20000],
    "recall.gate": [0, 1],
    "recall.halfLifeDays": [1, 3650],
    "write.maxPerDay": [0, 1000],
  };
  for (const [dotted, [min, max]] of Object.entries(numeric)) {
    const [group, key] = dotted.split(".");
    if (raw[group]?.[key] !== undefined) {
      out[group][key] = clampNumber(raw[group][key], out[group][key], min, max, dotted);
    }
  }
  if (out.dedupe.hintAt > out.dedupe.mergeAt) {
    throw new Error("config dedupe.hintAt 不能大于 dedupe.mergeAt");
  }
  return out;
}

/** Read `config.json`, falling back to defaults when absent. */
export async function loadConfig(base = ROOT) {
  const p = pathsFor(base);
  let raw;
  try {
    raw = await fs.readFile(p.config, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
  try {
    return mergeConfig(JSON.parse(raw.replace(/^\uFEFF/, "")));
  } catch (error) {
    throw new Error(`${p.config}: ${error.message}`);
  }
}

/** Write the resolved defaults so the knobs are discoverable and editable. */
export async function writeDefaultConfig(base = ROOT) {
  const p = pathsFor(base);
  await fs.mkdir(p.root, { recursive: true });
  await fs.writeFile(p.config, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return DEFAULT_CONFIG;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nowIso(date = new Date()) {
  return date.toISOString();
}

/** Short, sortable, collision-resistant id. */
export function makeId(now = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  const stamp = [
    now.getFullYear(),
    two(now.getMonth() + 1),
    two(now.getDate()),
    two(now.getHours()),
    two(now.getMinutes()),
    two(now.getSeconds()),
  ].join("");
  return `mem_${stamp}_${randomBytes(2).toString("hex")}`;
}

/** True when a record carries an expiry that has already passed. */
export function isExpired(record, nowMs = Date.now()) {
  if (!record.expires_at) return false;
  const t = Date.parse(record.expires_at);
  return Number.isFinite(t) && t <= nowMs;
}

/** Clamp helper that also rejects NaN. */
function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Build a complete record from loose input. Unknown fields are dropped, so a
 * hand-edited file or a bad CLI flag can never widen the schema silently.
 */
export function createRecord(input = {}, now = new Date()) {
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("memory text must not be empty");
  if (text.length > MAX_TEXT) throw new Error(`memory text is too long (max ${MAX_TEXT} chars)`);

  const kind = KINDS.includes(input.kind) ? input.kind : "fact";
  const scope = SCOPES.includes(input.scope) ? input.scope : "user";

  const record = {
    id: input.id || makeId(now),
    text,
    kind,
    scope,
    subject: input.subject ? String(input.subject) : "user",
    status: STATUSES.includes(input.status) ? input.status : "active",
    confidence: num(input.confidence, 0.8, 0, 1),
    importance: Math.round(num(input.importance, 3, 1, 5)),
    pinned: Boolean(input.pinned),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12)
      : [],
    // Alternate wordings the same fact may be asked about later. This is how
    // lexical search gets a semantic foothold without embeddings: "简短" is
    // also stored as "简洁 / 精炼", so the paraphrase still matches.
    aliases: Array.isArray(input.aliases)
      ? [...new Set(input.aliases.map((a) => String(a).trim()).filter(Boolean))]
          .filter((a) => a.length <= 60)
          .slice(0, 12)
      : [],
    // A stable identity for "the same thing over time", e.g. project.deploy.
    // Two memories sharing a key are the same fact restated, regardless of
    // wording, so the newer one replaces the older one.
    key: input.key ? String(input.key).trim().slice(0, 80) : null,
    source: normalizeSource(input.source),
    created_at: input.created_at || nowIso(now),
    // When the fact became true, which is not the same as when it was recorded.
    // Keeping both is what lets recall answer "what was true in September".
    observed_at: input.observed_at || null,
    updated_at: input.updated_at || nowIso(now),
    last_used_at: input.last_used_at || null,
    uses: Math.max(0, Math.round(Number(input.uses) || 0)),
    expires_at: input.expires_at || null,
    supersedes: input.supersedes || null,
    superseded_by: input.superseded_by || null,
    sensitive: Boolean(input.sensitive),
  };
  return record;
}

function normalizeSource(source) {
  if (!source || typeof source !== "object") return null;
  const out = {};
  for (const key of ["session", "turn", "quote", "file", "url"]) {
    if (source[key]) out[key] = String(source[key]).slice(0, 2_000);
  }
  return Object.keys(out).length ? out : null;
}

/** Apply a patch to an existing record, validating through createRecord. */
export function patchRecord(record, patch = {}, now = new Date()) {
  const merged = { ...record, ...patch };
  if (patch.text !== undefined) merged.text = patch.text;
  const next = createRecord(merged, now);
  next.id = record.id;
  next.created_at = record.created_at;
  next.updated_at = nowIso(now);
  next.uses = patch.uses !== undefined ? Math.max(0, Math.round(Number(patch.uses) || 0)) : record.uses;
  return next;
}

/**
 * Read every record. Malformed lines are reported instead of throwing so
 * `doctor` can show them; callers that would rewrite the file must refuse
 * when `errors` is non-empty (see withStore).
 */
export async function readAll(base = ROOT) {
  const p = pathsFor(base);
  let raw;
  try {
    raw = await fs.readFile(p.data, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], errors: [], bytes: 0 };
    throw error;
  }
  const text = raw.replace(/^\uFEFF/, "");
  const records = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      errors.push({ line: index + 1, message: "invalid JSON" });
    }
  });
  return { records, errors, bytes: Buffer.byteLength(text, "utf8") };
}

async function renameWithRetry(from, to) {
  let delay = 20;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const transient = ["EACCES", "EBUSY", "EPERM"].includes(error.code);
      if (!transient || attempt >= 8) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 200);
    }
  }
}

async function writeAll(records, base = ROOT) {
  const p = pathsFor(base);
  await fs.mkdir(p.root, { recursive: true });
  const body = records.length ? `${records.map((r) => JSON.stringify(r)).join("\n")}\n` : "";
  const tmp = `${p.data}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await renameWithRetry(tmp, p.data);
}

async function acquireLock(base = ROOT) {
  const p = pathsFor(base);
  await fs.mkdir(p.root, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(p.lock, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowIso() }));
      await handle.close();
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(p.lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(p.lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("memory store is locked by another process");
      await sleep(25);
    }
  }
}

async function releaseLock(base = ROOT) {
  await fs.rm(pathsFor(base).lock, { force: true });
}

/** One backup per day, newest 14 kept. */
async function maybeBackup(records, base = ROOT) {
  if (!records.length) return;
  const p = pathsFor(base);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(p.backups, `${day}.jsonl`);
  await fs.mkdir(p.backups, { recursive: true });
  const exists = await fs.stat(file).then(() => true, () => false);
  if (!exists) {
    await fs.writeFile(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    const entries = (await fs.readdir(p.backups)).filter((n) => n.endsWith(".jsonl")).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - 14))) {
      await fs.rm(path.join(p.backups, old), { force: true });
    }
  }
}

/**
 * Run a read-modify-write transaction.
 *
 * `fn(records)` may mutate the array and returns a result object; set
 * `write: false` on it to skip persisting (read-only commands). If the file
 * contained malformed lines the transaction refuses to write, so a corrupt
 * line can never be silently deleted by an unrelated command.
 */
export async function withStore(fn, base = ROOT) {
  await acquireLock(base);
  try {
    const { records, errors } = await readAll(base);
    if (errors.length) {
      const error = new Error(
        `memory store has ${errors.length} unreadable line(s); run "mem.mjs doctor" before writing`,
      );
      error.code = "ESTORE_CORRUPT";
      error.lines = errors;
      throw error;
    }
    const result = (await fn(records)) ?? {};
    if (result.write !== false) {
      await maybeBackup(records, base);
      await writeAll(records, base);
    }
    return result;
  } finally {
    await releaseLock(base);
  }
}

/** Read-only helper (no lock: writes commit by atomic rename). */
export async function readStore(base = ROOT) {
  return readAll(base);
}

/**
 * Find a record by exact id, unique id prefix, or unique trailing suffix.
 * The suffix form (`4a23`) is what the CLI displays, so users and the model
 * can refer to a memory without copying the time stamp.
 */
export function findRecord(records, idOrPrefix) {
  const needle = String(idOrPrefix || "").trim();
  if (!needle) return { record: null, matches: [] };

  const exact = records.find((r) => r.id === needle);
  if (exact) return { record: exact, matches: [exact] };

  const prefixed = records.filter((r) => r.id.startsWith(needle));
  if (prefixed.length === 1) return { record: prefixed[0], matches: prefixed };
  if (prefixed.length > 1) return { record: null, matches: prefixed };

  const suffixed = records.filter((r) => r.id.endsWith(needle));
  return { record: suffixed.length === 1 ? suffixed[0] : null, matches: suffixed };
}

/** Display form: the random suffix, e.g. `4a23`. */
export function shortId(id) {
  const parts = String(id).split("_");
  return parts.length >= 3 ? parts[parts.length - 1] : String(id);
}

/** Timestamp used by time filters and recency: when it happened, else when recorded. */
export function recordTime(record) {
  return record.observed_at || record.created_at;
}

export function daysBetween(fromIso, toMs = Date.now()) {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (toMs - t) / DAY_MS);
}
