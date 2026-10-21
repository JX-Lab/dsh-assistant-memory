import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { remember, recall, list, forget, stats } from "../lib/api.mjs";
import { pathsFor } from "../lib/store.mjs";

const temp = () => mkdtemp(path.join(os.tmpdir(), "assistant-memory-"));

test("remember then recall finds the record", async () => {
  const dir = await temp();
  const payload = await remember({ text: "用户喜欢先给结论", kind: "preference" }, dir);
  assert.equal(payload.action, "created");

  const items = await recall({ query: "结论" }, dir);
  assert.equal(items.length, 1);
  assert.match(items[0].text, /先给结论/);
});

test("a fact key replaces the old statement even with new wording", async () => {
  const dir = await temp();
  await remember({ text: "项目部署在 AWS us-east-1", key: "project.deploy", scope: "project" }, dir);
  const second = await remember(
    { text: "现在全套搬到 GCP asia-east1 了", key: "project.deploy", scope: "project" },
    dir,
  );
  assert.equal(second.action, "superseded");

  const active = await list({}, dir);
  assert.equal(active.length, 1);
  assert.match(active[0].text, /GCP/);
});

test("restating the exact same text is a no-op", async () => {
  const dir = await temp();
  await remember({ text: "回答简短" }, dir);
  const again = await remember({ text: "回答简短" }, dir);
  assert.equal(again.action, "unchanged");
  const items = await list({}, dir);
  assert.equal(items.length, 1);
});

test("sensitive content is refused by default", async () => {
  const dir = await temp();
  await assert.rejects(
    () => remember({ text: "我的密钥 sk-abcdefghijklmnopqrstuvwxyz0123" }, dir),
    /敏感信息/,
  );
});

test("forget archives instead of deleting", async () => {
  const dir = await temp();
  const created = await remember({ text: "临时规则" }, dir);
  const result = await forget({ id: created.record.id }, dir);
  assert.equal(result.action, "archived");
  assert.equal((await list({}, dir)).length, 0);
  assert.equal((await list({ status: "archived" }, dir)).length, 1);
});

test("the daily write guard blocks and force bypasses it", async () => {
  const dir = await temp();
  await writeFile(pathsFor(dir).config, JSON.stringify({ write: { maxPerDay: 1 } }), "utf8");
  await remember({ text: "第一条" }, dir);
  await assert.rejects(() => remember({ text: "第二条" }, dir), /上限/);
  const forced = await remember({ text: "第二条", force: true }, dir);
  assert.equal(forced.action, "created");
});

test("stats reports the store without throwing on an empty file", async () => {
  const dir = await temp();
  const before = await stats(dir);
  assert.equal(before.total, 0);
  assert.equal(before.parseErrors, 0);
});
