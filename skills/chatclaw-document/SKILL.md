---
name: chatclaw-document
description: |
  ChatClaw 云文档技能。当用户发送、创建、编辑云文档时使用。
  文档内容保存在账号目录下的 .md 文件中，智能体直接编辑原文件。
---

# ChatClaw 云文档技能

## 概述

用户可以创建、发送云文档给智能体。文档正文不再走数据库回写，而是直接落盘为 `.md` 文件，智能体拿到 `file_path` 后直接读取或编辑原文件。

## 强制规则

1. `accountId` 必须使用真实账号 ID，例如 `chatclaw_4813494d137e1631`；同时必须单独传 `agentId`。
2. 读取文档前必须先调用 `chatclaw_document(action=get)` 获取文档元信息和 `file_path`。
3. 编辑文档时必须直接修改 `file_path` 指向的原始 `.md` 文件，不再调用任何文档内容更新工具。
4. 编辑文档时必须维护任务日志：开始标记 `running`，完成标记 `completed`，失败标记 `failed`。
5. 创建文档时传 `file_name`，不需要传后缀；传了其他后缀也会被插件替换为 `.md`。

## 工具

工具名：`chatclaw_document`，通过 `action` 参数区分操作。

### get - 获取文档详情

```json
{ "action": "get", "accountId": "chatclaw_4813494d137e1631", "agentId": "nova", "document_id": "doc_xxx" }
```

返回字段：

- `file_name`：文件名，固定 `.md` 后缀。
- `file_path`：完整文件路径。
- `summary`：文档摘要。
- `format`：固定为 `markdown`。
- `status`：状态。

### create - 创建新文档

```json
{
  "action": "create",
  "accountId": "chatclaw_4813494d137e1631",
  "agentId": "nova",
  "file_name": "周报",
  "summary": "摘要（可选）"
}
```

创建后插件会创建空白 `.md` 文件，并返回 `file_path`。同账号重名时会自动生成 `_2.md`、`_3.md`。

### list - 获取文档列表

```json
{ "action": "list", "accountId": "chatclaw_4813494d137e1631", "agentId": "nova", "page": 1, "page_size": 20 }
```

### update - 更新文档摘要

当需要更新文档摘要（summary）时使用，例如为简历补充概述：

```json
{
  "action": "update",
  "accountId": "chatclaw_4813494d137e1631",
  "agentId": "nova",
  "document_id": "doc_xxx",
  "summary": "张明，5年经验后端开发，擅长Java和微服务"
}
```

### create_task - 创建修改日志

```json
{
  "action": "create_task",
  "accountId": "chatclaw_4813494d137e1631",
  "agentId": "nova",
  "document_id": "doc_xxx",
  "task_type": "manual_update",
  "task_status": "running",
  "prompt": "开始补充会议纪要",
  "notes": "先补结构，再润色"
}
```

### update_task - 更新修改日志

```json
{
  "action": "update_task",
  "accountId": "chatclaw_4813494d137e1631",
  "agentId": "nova",
  "task_id": "dot_xxx",
  "task_status": "completed",
  "notes": "已写入最新版本"
}
```

失败时：

```json
{
  "action": "update_task",
  "accountId": "chatclaw_4813494d137e1631",
  "agentId": "nova",
  "task_id": "dot_xxx",
  "task_status": "failed",
  "error": "失败原因"
}
```

## 两种消息语义

### 上下文模式

当用户发送文档给你只是希望你了解内容时：

1. 调用 `chatclaw_document(action=get)` 获取 `file_path`。
2. 直接读取对应 `.md` 文件内容。
3. 总结核心要点和可继续完善方向。
4. 询问用户是否需要修改。
5. 不要直接修改原文件。

### 编辑模式

当用户希望你直接修改文档时：

1. 调用 `chatclaw_document(action=get)` 获取 `file_path`。
2. 如果用户请求中已经给出 `task_id`，直接更新该任务状态为 `running`。
3. 如果没有 `task_id`，先调用 `chatclaw_document(action=create_task)` 创建修改日志。
4. 直接编辑原始 `.md` 文件。
5. 完成后调用 `chatclaw_document(action=update_task)` 标记 `completed`。
6. 失败时调用 `chatclaw_document(action=update_task)` 标记 `failed` 并写入 `error`。
