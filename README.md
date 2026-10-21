# 工作助手记忆（dsh-assistant-memory）

给 [DeepSeek Harness](https://github.com/deepseek-ai) 的一份**跨会话长期记忆**：记住你的偏好、项目约定和纠正，下一次对话不用重新交代。

本地存储、纯文本、零依赖，不联网、不调用任何模型接口。

## 装

```sh
dsh plugin --profile web add github:JX-Lab/dsh-assistant-memory
```

装完重启 DSH。插件列表里会出现 **dsh-assistant-memory**，会话里多一个 `memory` 工具。

> 如果用的是桌面版，也可以打开 **设置 → 插件 → 安装**，填入这个包的目录。

## 它记什么

| 值得记 | 不建议记 |
| --- | --- |
| 稳定偏好（"以后回答简短点"） | 一次性的任务细节 |
| 纠正（"不对，应该……"） | 临时路径 |
| 项目约定：技术栈、部署环境、命名规则 | 模型的推测 |
| 已做出的决策及原因 | 整段对话原文 |

## 工具

会话里 AI 会自己调用，你不用记命令：

| action | 作用 |
| --- | --- |
| `brief` | 开场取背景（置顶 + 与任务相关的几条） |
| `recall` | 按关键词查 |
| `remember` | 记一条：一句话、自包含、可验证 |
| `list` | 列出记忆 |
| `forget` | 归档（不真删，可恢复） |

`remember` 支持几个提升质量的参数：

- `kind`：`preference` / `fact` / `project` / `correction` / `decision` / `person` / `workflow`
- `scope`：`user`（跨项目）/ `project` / `workspace` / `session`
- `key`：事实键，如 `project.deploy`。**同一件事的新说法会自动取代旧的**，不用靠句子相似度猜
- `aliases`：同义说法，让"简洁"也能命中"简短"
- `importance`：1–5，影响召回排序

## 数据在哪

```
%USERPROFILE%\.dsh\memory-assistant\memories.jsonl
```

一行一条 JSON，能 `diff`、能备份、能手动改。每天第一次写入会留一份备份到 `backups/`，保留 14 天。

从旧的工作区记忆迁移：把旧的 `memories.jsonl` 复制到这个目录即可，格式完全一致。

## 为什么不用向量库

记忆是短句，规模在千条以内。词法检索（中文二元组 + IDF 覆盖）加一点时间/重要性权重已经够用，而且**可解释**：为什么召回这条，能算出来。加向量要引入模型依赖、几百 MB 权重和一堆失败路径，等库里真到几千条再说。

## 隐私

- 数据只在本地，插件不发任何网络请求。
- 写入前扫描密钥、令牌、连接串、身份证、手机号；命中默认拒绝。
- `forget` 是归档不是删除；要真删，直接改 JSONL 或删文件。

## 开发

```sh
node test/api.test.mjs
```

## License

MIT
