---
name: chatclaw-memo
description: |
  ChatClaw 语音备忘技能。当用户录制语音备忘时，智能体负责整理备忘内容。
  用户说「整理备忘」「查看备忘」或智能体收到备忘消息时使用。
---

# ChatClaw 语音备忘技能

## 概述

用户可以录制语音备忘，智能体负责调用工具整理备忘内容。

## 强制规则

**accountId 必须使用真实账号 ID，例如 `chatclaw_4813494d137e1631`。**

## 工具

工具名：`chatclaw_memo`，通过 `action` 参数区分操作。

---

### get - 获取备忘详情

```json
{ "action": "get", "accountId": "chatclaw_4813494d137e1631", "memo_id": "memo-xxx" }
```

**返回字段说明：**
- `voice_path`：语音文件的本地路径，可用于读取
- `voice_url`：语音文件的访问 URL
- `status`：processing（处理中）/ completed（已完成）/ failed（失败）

**智能体需要自行完成语音识别和 AI 整理。**

---

### update - 更新备忘

```json
{
  "action": "update",
  "accountId": "chatclaw_4813494d137e1631",
  "memo_id": "memo-xxx",
  "title": "下午3点开会",
  "summary": "记得带项目文档",
  "content": "## 会议\n\n- 时间：下午3点\n- 地点：会议室A",
  "keywords": ["会议", "文档"]
}
```

**调用此工具后，整理结果会自动推送给用户。**

---

### list - 获取备忘列表

```json
{ "action": "list", "accountId": "chatclaw_4813494d137e1631", "page": 1, "page_size": 20 }
```

---

## 整理流程

当收到用户发送的语音备忘消息时：

1. 调用 `chatclaw_memo_get` 获取备忘详情
2. 读取 `voice_path` 语音文件
3. **自行调用 Whisper 进行语音识别** → 获取文字内容
4. **AI 整理**：提取 title/summary/content/keywords
5. 调用 `chatclaw_memo_update` 提交结果

**注意：插件不提供语音转文字功能，智能体需自行调用 Whisper API 或其他 ASR 服务。**

## 消息格式

备忘消息的 content 字段格式为：

```
[语音备忘] memo_id: xxx
```

智能体需要理解这是请求整理的信号。
