// Assistant memory — a self-contained DSH plugin.
//
// The engine lives in ./lib and stores a JSONL file under the user's DSH home,
// so upgrading or moving the workspace never touches the memories themselves.
import { defineTool } from "@deepseek-ai/dsh-tools";
import { remember, recall, brief, list, forget } from "./lib/api.mjs";
import { shortId } from "./lib/store.mjs";

export const name = "assistant-memory";
export const inject = ["tools"];

const ACTIONS = ["brief", "recall", "remember", "list", "forget"];

const TEXT_OUTPUT = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { result: { type: "string", required: true } },
  },
  render: (_args, value) => [{ type: "text", text: value.result }],
};

function kindLabel(kind) {
  return (
    {
      preference: "偏好",
      fact: "事实",
      project: "项目",
      correction: "纠正",
      decision: "决策",
      person: "人物",
      workflow: "流程",
    }[kind] || kind
  );
}

async function dispatch(args) {
  switch (args.action) {
    case "remember": {
      const payload = await remember({
        text: args.text,
        kind: args.kind,
        scope: args.scope,
        key: args.key,
        aliases: args.aliases,
        importance: args.importance,
        source: args.source_session ? { session: args.source_session, quote: args.source_quote } : null,
      });
      const lines = [`✓ ${payload.action} [${shortId(payload.record.id)}] ${payload.record.text}`];
      if (payload.similar_to) {
        lines.push(
          `! 已有相似记忆 [${shortId(payload.similar_to.id)}]：${payload.similar_to.text}`,
          `  若是同一件事的新说法，用 key 或 supersedes 更新它。`,
        );
      }
      return lines.join("\n");
    }
    case "recall": {
      const items = await recall({
        query: args.query,
        limit: args.limit,
        scope: args.scope,
        kind: args.kind,
      });
      if (!items.length) return `没有匹配「${args.query ?? ""}」的记忆。`;
      return items.map((i) => `- [${i.shortId}] ${kindLabel(i.kind)}｜${i.text}`).join("\n");
    }
    case "brief":
      return brief({ query: args.query });
    case "list": {
      const items = await list({ status: args.status, scope: args.scope, kind: args.kind });
      if (!items.length) return "没有符合条件的记忆。";
      return items
        .map((i) => `[${i.shortId}] ${kindLabel(i.kind)}/${i.scope} ${i.status === "active" ? "" : `(${i.status}) `}${i.text}`)
        .join("\n");
    }
    case "forget": {
      const payload = await forget({ id: args.id });
      return payload.action === "deleted" ? `已彻底删除 [${shortId(payload.id)}]` : `已归档 [${shortId(payload.id)}]`;
    }
    default:
      throw new Error(`未知 action: ${args.action}`);
  }
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "memory",
      description:
        "工作助手记忆：跨会话记住用户的偏好、项目约定和纠正。brief：开场取背景；recall：按关键词查；remember：记一条（text 必填）；list：列出；forget：归档。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ACTIONS,
          description: "要执行的操作。",
        },
        text: { type: "string", description: "remember 的内容：一句话、自包含、可验证。" },
        query: { type: "string", description: "recall / brief 的查询词。" },
        id: { type: "string", description: "forget 的目标 id（可只写后 4 位）。" },
        kind: {
          type: "string",
          enum: ["preference", "fact", "project", "correction", "decision", "person", "workflow", "other"],
          description: "记忆分类，默认 fact。",
        },
        scope: {
          type: "string",
          enum: ["user", "project", "workspace", "session"],
          description: "作用域，默认 user。",
        },
        key: {
          type: "string",
          description: "事实键（对象.方面，如 project.deploy）。同键的新记录自动取代旧的。",
        },
        aliases: { type: "string", description: "逗号分隔的同义说法，便于以后换个词也能搜到。" },
        importance: { type: "integer", description: "重要度 1-5，默认 3。" },
        limit: { type: "integer", description: "recall 返回条数，默认 8。" },
        status: {
          type: "string",
          enum: ["active", "archived", "superseded", "all"],
          description: "list 的状态过滤，默认 active。",
        },
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        return { result: await dispatch(args) };
      },
    }),
  );
}
