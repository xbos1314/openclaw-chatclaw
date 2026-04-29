# ChatClaw Gateway

> OpenClaw 插件，通过 WebSocket 为客户端应用提供与 OpenClaw 智能体的通信能力

## 1. 项目概述

**项目名称**: openclaw-chatclaw
**项目描述**: OpenClaw 频道插件，通过 WebSocket + HTTP API 连接客户端与 OpenClaw 智能体
**定位**: OpenClaw 智能体通信网关

### 核心功能

- **通信**: WebSocket 实时消息收发、HTTP REST API 认证和查询
- **消息**: 文字/语音/文件/图片/视频消息收发，支持流式输出
- **账号**: 用户名/密码认证，Argon2 密码哈希，多设备同时在线
- **语音备忘**: 语音录制、AI 识别、智能体处理完整流程
- **小程序**: AI 驱动的轻量级应用创建、编辑、构建、发布
- **云文档**: 账号隔离的 Markdown 文档管理

## 2. 技术架构

### 2.1 整体架构

```
┌─────────────────┐     WebSocket      ┌──────────────────────────┐
│     客户端       │ ←───────────────→ │  openclaw-chatclaw 插件  │
│                 │                   │   (OpenClaw Gateway 端)  │
└─────────────────┘                    └───────────┬──────────────┘
                                                    │
                                    OpenClaw channelRuntime dispatch
                                                    │
                                          ┌─────────▼─────────┐
                                          │  OpenClaw 智能体   │
                                          └───────────────────┘
```

**核心定位**: 插件作为混合通信网关，通过 OpenClaw channelRuntime 与 Agent 通信。

通信职责：

- **WebSocket**: 实时消息收发、Agent 回复推送、打字状态和心跳。
- **HTTP REST API**: 登录认证、消息查询、文件管理、语音备忘、小程序等查询和操作类请求。

### 2.2 项目结构

```
chatclaw_gateway/
├── src/
│   ├── api/
│   │   ├── types.ts           # API / WebSocket 消息类型定义
│   │   └── openclaw-client.ts # OpenClaw 客户端封装
│   ├── auth/
│   │   ├── accounts.ts        # 账号管理（用户名/密码）
│   │   └── token.ts           # Token 管理
│   ├── channel.ts             # ChannelPlugin 入口（含出站发送）
│   ├── compat.ts              # 兼容性处理
│   ├── config/
│   │   └── config-schema.ts   # 配置 Schema
│   ├── db/
│   │   ├── message.ts         # 消息数据库（messages.db）
│   │   ├── files.ts           # 文件数据库（files.db）
│   │   ├── memos.ts           # 语音备忘数据库（memos.db）
│   │   ├── miniprograms.ts    # 小程序数据库
│   │   └── documents.ts       # 云文档数据库
│   ├── document/
│   │   ├── tools.ts           # chatclaw_document 工具注册
│   │   ├── dispatcher.ts      # 文档请求分发
│   │   └── storage.ts         # 文档存储
│   ├── http/
│   │   ├── server.ts          # HTTP 服务器入口
│   │   ├── memo-handlers.ts   # 语音备忘 REST API
│   │   ├── miniprogram-handlers.ts # 小程序 REST API
│   │   └── document-handlers.ts # 云文档 REST API
│   ├── media/
│   │   ├── download.ts        # 文件下载（APP → 服务端）
│   │   ├── upload.ts          # 文件上传（服务端 → 存储）
│   │   ├── storage.ts         # 媒体存储
│   │   ├── fileStorage.ts     # 文件存储
│   │   ├── filePolicy.ts      # 文件策略
│   │   ├── voiceStorage.ts    # 语音文件存储
│   │   └── audioDuration.ts   # 音频时长获取
│   ├── memo/
│   │   ├── tools.ts           # chatclaw_memo 工具注册
│   │   └── dispatcher.ts     # 备忘创建后通知智能体
│   ├── miniprogram/           # 小程序功能
│   │   ├── tools.ts          # chatclaw_miniprogram 工具注册
│   │   ├── dispatcher.ts     # 小程序请求分发到智能体
│   │   ├── build.ts           # 小程序构建
│   │   ├── storage.ts        # 小程序文件存储
│   │   ├── file-storage.ts    # 小程序文件管理
│   │   ├── gateway-session.ts # 小程序会话管理
│   │   ├── custom-api.ts     # 小程序自定义 API
│   │   └── validator.ts       # 小程序验证器
│   ├── runtime.ts             # 保存 OpenClaw PluginRuntime
│   ├── session/
│   │   └── routing.ts        # SessionKey 路由
│   ├── typing/
│   │   └── state.ts          # 打字状态管理
│   ├── websocket/
│   │   └── server.ts         # WebSocket 服务端
│   ├── scripts/
│   │   └── manage-accounts.ts # 账号管理脚本
│   └── util/
│       └── logger.ts
├── index.ts
├── openclaw.plugin.json
└── package.json
```

## 3. 已实现功能

| 功能 | 状态 | 说明 |
|------|------|------|
| WebSocket 服务端 | ✅ 完成 | 端口 9788，支持多客户端连接 |
| 用户名/密码认证 | ✅ 完成 | Argon2 密码哈希，通过 HTTP `/auth` 登录获取 token |
| 消息分发到 Agent | ✅ 完成 | 通过 channelRuntime.reply.dispatchReplyFromConfig |
| Agent 回复推送 | ✅ 完成 | 通过 deliver 回调经 WebSocket 发送 |
| 智能体列表 | ✅ 完成 | 返回 OpenClaw 配置的 Agent |
| 文件/图片/语音接收 | ✅ 完成 | APP → 服务端文件下载 |
| 文件/图片/语音发送 | ✅ 完成 | 服务端上传到文件服务器后推送 URL |
| 离线消息 | ✅ 完成 | 用户离线时缓存，登录后自动推送 |
| 出站消息（Agent → 用户） | ✅ 完成 | 支持 Agent 主动向用户推送消息 |
| 流式输出 | ✅ 完成 | 支持 AI 流式回复（可配置合并） |
| 媒体文件安全检查 | ✅ 完成 | 验证文件路径在 Agent 工作区内 |
| 文件记录管理 | ✅ 完成 | 独立 files.db，按类型查询、删除 |
| 用户头像 | ✅ 完成 | 支持更新和同步用户头像 |
| SessionKey 路由 | ✅ 完成 | 通过标准 sessionKey 传递和恢复 Agent ID |
| 语音备忘 API | ✅ 完成 | REST API 创建/查询/更新/删除备忘 |
| chatclaw_memo 工具 | ✅ 完成 | 智能体调用工具获取/更新备忘 |
| 备忘通知智能体 | ✅ 完成 | 备忘创建后自动通知智能体处理 |
| 小程序功能 | ✅ 完成 | 完整的创建、编辑、构建、发布流程 |
| chatclaw_miniprogram 工具 | ✅ 完成 | 智能体调用工具操作小程序 |
| 云文档功能 | ✅ 完成 | 文档内容落盘为账号隔离的 Markdown 文件 |
| chatclaw_document 工具 | ✅ 完成 | 智能体获取文件路径并维护文档修改任务日志 |

## 4. 数据存储

### 4.1 账号数据

账号索引路径：`~/.openclaw/openclaw-chatclaw/accounts.json`

账号文件路径：`~/.openclaw/openclaw-chatclaw/accounts/{accountId}.json`

| 字段 | 类型 | 说明 |
|------|------|------|
| username | string | 用户名 |
| passwordHash | string | Argon2 密码哈希 |
| accountId | string | 账号 ID，格式为 `chatclaw_{usernameHash}` |
| createdAt | string | 创建时间 |
| lastConnected | string | 最后登录时间 |
| avatarUrl | string | 头像 URL |

### 4.2 消息数据库（messages.db）

路径：`~/.openclaw/openclaw-chatclaw/messages.db`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | UUID 消息唯一标识 |
| account_id | TEXT | 用户账号 ID |
| agent_id | TEXT | 智能体 ID |
| direction | TEXT | `inbound`(用户→Agent) / `outbound`(Agent→用户) |
| content_type | TEXT | `text` / `image` / `file` / `voice` / `video` |
| content | TEXT | 消息内容 |
| file_url | TEXT | 附件 URL |
| file_name | TEXT | 附件文件名 |
| file_size | INTEGER | 附件大小（字节） |
| duration | INTEGER | 时长（毫秒） |
| file_id | TEXT | 文件服务器返回的文件ID |
| request_id | TEXT | 请求 ID |
| status | TEXT | 消息状态（默认 `completed`） |
| read | INTEGER | 已读标志：0=未读，1=已读 |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

### 4.3 文件数据库（files.db）

路径：`~/.openclaw/openclaw-chatclaw/files.db`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | UUID 记录唯一标识 |
| file_id | TEXT | 文件服务器返回的文件ID |
| file_url | TEXT | 文件 URL |
| file_name | TEXT | 文件名 |
| file_size | INTEGER | 文件大小（字节） |
| content_type | TEXT | 文件类型 |
| account_id | TEXT | 用户账号 ID |
| agent_id | TEXT | 智能体 ID |
| created_at | INTEGER | 创建时间戳 |

文件记录与消息的关系：

- 智能体发送文件时，会同时保存到 `messages.db` 和 `files.db`。
- 删除消息不会删除文件记录。
- 删除文件记录不会删除消息。
- APP 可以通过 `GET /files` 获取文件列表，通过 `DELETE /files/:id` 删除文件记录。

### 4.4 语音备忘数据库（memos.db）

路径：`~/.openclaw/openclaw-chatclaw/memos.db`

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | UUID 备忘唯一标识 |
| account_id | TEXT | 用户账号 ID（不含智能体后缀） |
| agent_id | TEXT | 智能体 ID |
| title | TEXT | 备忘标题 |
| summary | TEXT | 内容摘要 |
| content | TEXT | 完整内容 |
| keywords | TEXT | 关键词（JSON 数组） |
| voice_url | TEXT | 语音文件 URL |
| voice_path | TEXT | 语音文件本地路径 |
| original_text | TEXT | 原始语音识别文本 |
| status | TEXT | 状态：`pending` / `processing` / `completed` |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

### 4.5 小程序数据库（miniprograms.db）

路径：`~/.openclaw/openclaw-chatclaw/miniprograms.db`

| 字段 | 类型 | 说明 |
|------|------|------|
| app_id | TEXT | 小程序唯一标识（UUID） |
| account_id | TEXT | 用户账号 ID |
| agent_id | TEXT | 智能体 ID |
| name | TEXT | 小程序名称 |
| description | TEXT | 小程序描述 |
| prompt | TEXT | AI 提示词配置 |
| tools | TEXT | 工具配置（JSON 数组） |
| status | TEXT | 状态：`draft` / `building` / `ready` / `failed` |
| version | INTEGER | 当前版本号 |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

### 4.6 云文档数据库（documents.db）

路径：`~/.openclaw/openclaw-chatclaw/documents.db`

文档正文不保存在数据库中，数据库只保存元数据；正文文件保存在 `~/.openclaw/openclaw-chatclaw/documents/{accountId}/`。

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 文档唯一标识 |
| account_id | TEXT | 用户账号 ID |
| agent_id | TEXT | 智能体 ID |
| file_name | TEXT | Markdown 文件名 |
| file_path | TEXT | Markdown 文件完整路径 |
| summary | TEXT | 摘要 |
| format | TEXT | 固定为 `markdown` |
| source | TEXT | 来源：`user` / `agent` / `imported` |
| status | TEXT | 状态：`ready` / `processing` / `failed` / `archived` |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

### 4.7 云文档任务表（document_tasks）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT | 任务唯一标识 |
| document_id | TEXT | 所属文档 ID |
| account_id | TEXT | 用户账号 ID |
| agent_id | TEXT | 智能体 ID |
| task_type | TEXT | 任务类型：`update` / `manual_update` |
| status | TEXT | 状态：`pending` / `running` / `completed` / `failed` |
| prompt | TEXT | 修改请求 |
| notes | TEXT | 备注 |
| request_message_id | TEXT | 请求消息 ID |
| result_message_id | TEXT | 结果消息 ID |
| error_message | TEXT | 错误信息 |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

### 4.8 小程序任务表（miniprogram_tasks）

| 字段 | 类型 | 说明 |
|------|------|------|
| task_id | TEXT | 任务唯一标识 |
| app_id | TEXT | 所属小程序 ID |
| type | TEXT | 任务类型：`create` / `update` / `build` / `manual_update` |
| status | TEXT | 状态：`pending` / `running` / `completed` / `failed` |
| result_message_id | TEXT | 结果消息 ID |
| notes | TEXT | 备注信息 |
| created_at | INTEGER | 创建时间戳 |
| updated_at | INTEGER | 更新时间戳 |

## 5. 云文档功能

### 5.1 API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /document | 创建空白 Markdown 文档 |
| GET | /document/list | 获取文档列表 |
| GET | /document/{id} | 获取文档元信息 |
| PUT | /document/{id} | 更新文档元信息或重命名文件 |
| DELETE | /document/{id} | 删除文档记录和文件 |
| GET | /document/{id}/file | 获取 Markdown 文件内容 |
| PUT | /document/{id}/file | 保存 Markdown 文件内容 |
| POST | /document/{id}/send | 将文档发送给智能体 |
| GET | /document/{id}/tasks | 获取文档修改任务日志 |

### 5.2 创建规则

- 创建文档时使用 `file_name`，不需要传文件后缀。
- 如果传入其他后缀，插件会统一替换为 `.md`。
- 每个账号独立目录。
- 同账号同名文件自动追加 `_2.md`、`_3.md`。
- 创建后返回完整 `filePath`，智能体直接编辑该文件。

### 5.3 智能体工具

**工具名称**: `chatclaw_document`

| 参数 | 类型 | 说明 |
|------|------|------|
| action | string | `create` / `get` / `list` / `create_task` / `update_task` |
| accountId | string | 真实账号 ID |
| agentId | string | 智能体 ID |
| document_id | string | 文档 ID |
| file_name | string | 文件名，action=create 时必填 |
| task_id | string | 任务 ID，action=update_task 时必填 |
| task_type | string | `update` / `manual_update` |
| task_status | string | `pending` / `running` / `completed` / `failed` |
| prompt | string | 修改请求 |
| notes | string | 备注 |
| error | string | 失败原因 |

## 6. 小程序功能

### 6.1 概述

小程序是 AI 驱动的轻量级应用，由智能体根据用户描述自动生成配置和工具。

### 6.2 API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/miniprogram/create | 创建小程序 |
| GET | /api/miniprogram/list | 获取小程序列表 |
| GET | /api/miniprogram/{appId} | 获取小程序详情 |
| DELETE | /api/miniprogram/{appId} | 删除小程序 |
| POST | /api/miniprogram/{appId}/send | 发送小程序给智能体 |
| POST | /api/miniprogram/{appId}/build | 构建小程序 |
| POST | /api/miniprogram/{appId}/reload | 重新加载小程序 |
| POST | /api/miniprogram/{appId}/revise | 修订小程序 |
| GET | /api/miniprogram/{appId}/tasks | 获取任务列表 |
| GET/PUT | /api/miniprogram/{appId}/project-files | 获取或保存项目文件 |
| POST | /api/miniprogram/{appId}/file/upload | 上传小程序文件 |
| GET | /api/miniprogram/{appId}/file/{fileId} | 预览或下载小程序文件 |
| DELETE | /api/miniprogram/{appId}/file/{fileId} | 删除小程序文件 |
| GET | /miniprogram/{appId} | 访问小程序公开页面 |

### 6.3 处理流程

```
1. APP 创建小程序 → POST /api/miniprogram/create
2. 记录创建任务（task_type=create, status=pending）
3. dispatchMiniprogramRequest 分发请求到智能体
4. 智能体收到 [miniprogram_request: create]
5. 智能体调用 chatclaw_miniprogram (action=create) 创建小程序
6. 智能体调用 chatclaw_miniprogram (action=create_task) 创建任务记录
7. 智能体调用 chatclaw_miniprogram (action=set_ready) 标记就绪
8. 结果推送给 APP
```

### 6.4 智能体工具

**工具名称**: `chatclaw_miniprogram`

| 参数 | 类型 | 说明 |
|------|------|------|
| action | string | `create` / `get` / `update` / `list` / `list_files` / `build` / `set_ready` / `set_failed` / `create_task` / `update_task` |
| app_id | string | 小程序 ID（action=get/update/list_files/build/set_ready/set_failed 时必填） |
| name | string | 小程序名称（action=create 时可选） |
| description | string | 小程序描述（action=create 时可选） |
| agent_id | string | 智能体 ID（action=create 时必填） |
| prompt | string | 提示词配置（action=update 时可选） |
| tools | string[] | 工具列表（action=update 时可选） |
| notes | string | 备注（action=update_task 时可选） |
| task_id | string | 任务 ID（action=update_task 时必填） |
| task_status | string | 任务状态（action=update_task 时可选） |
| task_type | string | 任务类型（action=create_task 时必填） |
| request_message_id | string | 请求消息 ID（action=create_task 时必填） |
| result_message_id | string | 结果消息 ID（action=create_task 时可选） |
| summary | string | 结果摘要（action=create_task 时可选） |
| public_url | string | 公开 URL（action=set_ready 时可选） |
| sqlite_path | string | SQLite 路径（action=create 时可选） |
| subdir | string | 子目录（action=list_files 时可选） |
| page | number | 页码（action=list 时） |
| page_size | number | 每页数量（action=list 时） |

## 7. 语音备忘功能

### 7.1 API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /memo/voice | 上传语音创建备忘 |
| GET | /memo/list | 获取备忘列表 |
| GET | /memo/{id} | 获取单个备忘 |
| POST | /memo/{id}/send | 将备忘发送给智能体作为上下文 |
| PUT | /memo/{id} | 更新备忘 |
| DELETE | /memo/{id} | 删除备忘 |
| GET | /voices/download/{accountId}/{voiceId} | 下载语音 |

### 7.2 处理流程

```
1. APP 长按录制 → POST /memo/voice
2. 保存语音文件 + 创建 memo 记录（status=pending）
3. dispatchMemoToAgent 异步通知智能体
4. 智能体收到 [memo: pending] 消息
5. 智能体调用 chatclaw_memo (action=get) 获取详情
6. 智能体调用 Whisper 识别语音
7. 智能体调用 chatclaw_memo (action=update) 提交结果
8. 结果推送给 APP
```

### 7.3 智能体工具

**工具名称**: `chatclaw_memo`

| 参数 | 类型 | 说明 |
|------|------|------|
| action | string | `get` / `update` / `list` |
| memo_id | string | 备忘 ID（action=get 时必填） |
| title | string | 标题（action=update 时可选） |
| summary | string | 摘要（action=update 时可选） |
| content | string | 内容（action=update 时可选） |
| keywords | string[] | 关键词（action=update 时可选） |
| page | number | 页码（action=list 时） |
| page_size | number | 每页数量（action=list 时） |

## 8. SessionKey 路由机制

### 8.1 背景

OpenClaw 原生渠道主要通过 `sessionKey` 持有 `agentId`。插件侧也统一改为基于标准会话键路由，而不是把 `agentId` 编进账号字符串。

### 8.2 解决方案

使用真实账号 + 标准 `sessionKey` 路由：

- **格式**: `agent:<agentId>:openclaw-chatclaw:direct:<accountId>`
- **入站**: 用户发消息 → 插件构造标准 `sessionKey` → OpenClaw 在对应 agent 会话内处理
- **出站**: OpenClaw 调用 `sendText` / `sendMedia` → 插件从 `sessionKey` 解析 `agentId` → 用真实账号通讯和保存

### 8.3 核心文件

- `src/session/routing.ts`: 构造和解析 ChatClaw 标准会话键
- `src/websocket/server.ts` 的 `dispatchToAgent`: 入站时写入真实账号和标准 `sessionKey`
- `src/channel.ts` 的 `sendText/sendMedia`: 从 `sessionKey` 解析 `agentId`

## 9. WebSocket 协议

### 9.1 连接流程

```
1. APP 先通过 HTTP `POST /auth` 提交 `username/password`
2. 服务端返回 token、account_id、username、avatar_url
3. APP 使用 `ws://<gateway>:9788/ws?token=<token>` 建立 WebSocket 连接
4. 服务端在 WebSocket 握手阶段校验 token；失败直接拒绝握手
5. APP 通过 HTTP `GET /agents` 获取智能体列表（含 `is_typing`）
6. 用户点击智能体 → APP 直接发送消息: { type: "send_text", agent_id: "<agent_id>", text: "你好" }
7. 插件分发到 OpenClaw Agent → 回复通过 WebSocket 推送
```

### 9.2 消息类型

| 方向 | type | 描述 |
|------|------|------|
| APP → Plugin | `send_text` | 发送文字（带 agent_id） |
| APP → Plugin | `send_image` | 发送图片（URL） |
| APP → Plugin | `send_audio` | 发送音频（URL） |
| APP → Plugin | `send_voice` | 发送语音（URL） |
| APP → Plugin | `send_video` | 发送视频（URL） |
| APP → Plugin | `send_file` | 发送文件（URL） |
| APP → Plugin | `ping` | 心跳 |
| Plugin → APP | `typing_start` | 智能体开始输入 |
| Plugin → APP | `typing_stop` | 智能体停止输入 |
| Plugin → APP | `message` | 收到智能体回复 |
| Plugin → APP | `message_sent` | 消息发送确认 |
| Plugin → APP | `pong` | 心跳响应 |
| Plugin → APP | `error` | 错误通知 |

### 9.3 HTTP 鉴权接口

以下接口不走 WebSocket 消息协议，而是通过 HTTP + `Authorization: Bearer <token>` 调用：

- `POST /auth`：用户名/密码登录，获取 token、account_id、username、avatar_url
- `GET /agents`：获取智能体列表，返回 `id/name/description/avatar/is_typing`
- `GET /messages`、`GET /messages/sync`、`POST /messages/read`
- `GET /messages/unread-count`
- `GET /files`、`POST /files/upload`、`DELETE /files/:fileId`
- `GET /users/info`、`POST /users/avatar`

### 9.4 HTTP API 总表

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | `/health` | 健康检查 | 否 |
| POST | `/auth` | 用户名/密码登录 | 否 |
| GET | `/agents` | 获取智能体列表 | 是 |
| GET | `/messages` | 获取消息列表 | 是 |
| GET | `/messages/sync` | 增量同步消息 | 是 |
| POST | `/messages/read` | 标记消息已读 | 是 |
| GET | `/messages/unread-count` | 获取未读数 | 是 |
| DELETE | `/messages` | 清空消息 | 是 |
| DELETE | `/messages/:id` | 删除单条消息 | 是 |
| PATCH | `/messages/:id` | 更新消息 | 是 |
| GET | `/files` | 获取文件列表 | 是 |
| POST | `/files/upload` | 上传文件 | 是 |
| GET | `/files/download/:accountId/:fileId` | 下载文件 | 是 |
| DELETE | `/files/:id` | 删除文件记录 | 是 |
| GET | `/users/info` | 获取用户信息 | 是 |
| POST | `/users/avatar` | 更新头像 | 是 |
| POST | `/memo/voice` | 上传语音创建备忘 | 是 |
| GET | `/memo/list` | 获取备忘列表 | 是 |
| GET | `/memo/:id` | 获取单个备忘 | 是 |
| POST | `/memo/:id/send` | 将备忘发送给智能体 | 是 |
| PUT | `/memo/:id` | 更新备忘 | 是 |
| DELETE | `/memo/:id` | 删除备忘 | 是 |
| GET | `/voices/download/:accountId/:voiceId` | 下载语音文件 | 是 |
| POST | `/api/miniprogram/create` | 创建小程序 | 是 |
| GET | `/api/miniprogram/list` | 获取小程序列表 | 是 |
| GET | `/api/miniprogram/:appId` | 获取小程序详情 | 是 |
| DELETE | `/api/miniprogram/:appId` | 删除小程序 | 是 |
| POST | `/api/miniprogram/:appId/send` | 发送小程序给智能体 | 是 |
| POST | `/api/miniprogram/:appId/build` | 构建小程序 | 是 |
| POST | `/api/miniprogram/:appId/reload` | 重新加载小程序 | 是 |
| POST | `/api/miniprogram/:appId/revise` | 修订小程序 | 是 |
| GET | `/api/miniprogram/:appId/tasks` | 获取小程序任务列表 | 是 |
| GET/PUT | `/api/miniprogram/:appId/project-files` | 获取或保存项目文件 | 是 |
| POST | `/api/miniprogram/:appId/file/upload` | 上传小程序文件 | 否（需小程序会话 Cookie + 合法 Referer） |
| GET | `/api/miniprogram/:appId/file/:fileId` | 预览或下载小程序文件 | 否（需小程序会话 Cookie + 合法 Referer） |
| DELETE | `/api/miniprogram/:appId/file/:fileId` | 删除小程序文件 | 否（需小程序会话 Cookie + 合法 Referer） |
| GET | `/miniprogram/:appId` | 访问小程序公开页面 | 否 |

分页响应格式：

```json
{
  "data": [],
  "total": 100,
  "page": 1,
  "page_size": 20,
  "total_pages": 5
}
```

错误响应格式：

```json
{
  "error": "Error message"
}
```

## 10. 消息分发流程

### 10.1 下行（客户端 → 智能体）

```
客户端
    │
    ▼ WebSocket (send_text with agent_id)
handleSendText()
    │
    ▼
dispatchToAgent()
    │
    ├── buildSessionKey()      # 构建 OpenClaw session key
    ├── build MsgContext       # 构建消息上下文（含标准 SessionKey）
    │
    ├── runtime.channel.session.recordInboundSession()  # 记录会话
    │
    ▼
createReplyDispatcherWithTyping()
    │
    ├── deliver = createDeliverCallback()  # AI 回复通过 WebSocket 发送
    │
    ▼
channelRuntime.reply.dispatchReplyFromConfig()
    │
    ▼ OpenClaw Agent 处理
    │
    ▼ deliver() 被调用
sendToClient() → WebSocket → 客户端
```

### 10.2 上行（智能体 → 客户端）

```
OpenClaw Agent
    │
    ▼ channel.sendText() / channel.sendMedia()
sendChatClawOutbound()
    │
    ├── parseAgentIdFromSessionKey()  # 从 sessionKey 解析智能体ID
    ├── uploadFile()             # 上传到文件服务器
    ├── messageDB.createMessage()   # 保存消息到 messages.db
    ├── filesDB.createFileRecord()  # 保存文件记录到 files.db
    │
    ▼
sendToClientByAccountId() → WebSocket → 客户端
```

## 11. 文件处理

### 11.1 媒体上传（服务端 → 本地文件存储）

- 当前实现不依赖外部文件服务器
- 媒体统一保存到 `~/.openclaw/openclaw-chatclaw/files/<accountId>/`
- 文件索引写入 `~/.openclaw/openclaw-chatclaw/files.db`
- 对外下载地址为 `/files/download/<accountId>/<fileId>`

### 11.2 媒体下载（客户端 → 服务端）

- APP 发送媒体 URL
- 服务端下载并保存到 `~/.openclaw/openclaw-chatclaw/files/`
- 将本地路径传递给 OpenClaw 处理

## 12. 账号体系

- **一个用户名** = 一个 ChatClaw 真实账号
- 账号数据存储在 `~/.openclaw/openclaw-chatclaw/accounts/{accountId}.json`
- 账号可选通过 `agentIds` 字段限制可访问的智能体 ID
- 密码使用 Argon2 哈希存储
- 账号需通过管理命令预先创建，或通过重置命令直接设置密码
- 支持多设备同时在线
- `sessionKey`: `agent:<agentId>:openclaw-chatclaw:direct:<accountId>` 用于标准会话路由
- 默认账号可访问全部智能体；若配置限制，则仅可查看和使用限制列表内的智能体 ID

### 12.1 账号管理命令

```bash
cd ~/path/to/openclaw-chatclaw

# 构建项目（执行账号管理命令需先对项目进行构建）
npm run build

# 创建账号
npm run account:create <用户名> <密码>

# 列出账号
npm run account:list

# 查看账号智能体限制
npm run account:list-agent-limits <用户名>

# 设置账号智能体限制（逗号分隔）
npm run account:set-agent-limits <用户名> <agentId1,agentId2,...>

# 清空账号智能体限制
npm run account:clear-agent-limits <用户名>

# 删除账号
npm run account:delete <用户名>

# 重置密码
npm run account:reset-password <用户名> <新密码>
```

全局命令（需先构建并通过 npm link 暴露 `chatclaw-account`）：

```bash
chatclaw-account create <用户名> <密码>
chatclaw-account list
chatclaw-account list-agent-limits <用户名>
chatclaw-account set-agent-limits <用户名> <agentId1,agentId2,...>
chatclaw-account clear-agent-limits <用户名>
chatclaw-account delete <用户名>
chatclaw-account reset-password <用户名> <新密码>
```

## 14. 配置项

```json
// openclaw.plugin.json
{
  "type": "object",
  "properties": {
    "port": {
      "type": "number",
      "default": 9788,
      "description": "Shared HTTP/WebSocket server port"
    },
    "maxConnections": {
      "type": "number",
      "default": 100,
      "description": "最大并发连接数"
    },
    "heartbeatInterval": {
      "type": "number",
      "default": 30000,
      "description": "心跳间隔 (ms)"
    }
  }
}
```

## 15. 安装部署

### 15.1 本地安装

由于插件包含 `child_process` 调用（用于小程序构建），需要本地安装：

```bash
# 克隆仓库
git clone https://github.com/xbos1314/openclaw-chatclaw.git
cd openclaw-chatclaw

# 安装依赖
npm install
```

### 15.2 配置令牌密钥

编辑 `.env` 文件，设置令牌密钥：

```bash
cd /path/to/openclaw-chatclaw
nano .env
```

修改 `CHATCLAW_TOKEN_SECRET` 的值（建议使用 `openssl rand -hex 32` 生成随机字符串）。

### 15.3 安装 FFmpeg（可选）

视频封面生成功能依赖 FFmpeg。插件会自动为上传的视频文件生成封面图（提取第 1 秒帧）。

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu/Debian:**
```bash
sudo apt install ffmpeg
```

**Windows:** 从 [ffmpeg.org](https://ffmpeg.org/download.html) 下载并添加到 PATH。

如未安装 FFmpeg，视频封面功能将静默失败（不影响其他功能）。

### 15.4 配置 OpenClaw

在 `~/.openclaw/openclaw.json` 中添加插件配置：

```json
"channels": {
  "openclaw-chatclaw": {
    "accounts": {}
  }
},
"plugins": {
  "load": {
    "paths": [
      "/path/to/openclaw-chatclaw"
    ]
  },
  "entries": {
    "openclaw-chatclaw": {
      "enabled": true
    }
  }
}
```

注意：将 `/path/to/openclaw-chatclaw` 替换为实际克隆仓库的路径。

### 15.5 重启 OpenClaw

```bash
openclaw gateway restart
```

## 16. 开发相关

### 16.1 编译插件

```bash
cd ~/Documents/project/chatclaw_gateway
npm run build
```

### 16.2 类型检查

```bash
npm run typecheck
```

### 16.3 运行测试

```bash
npm test
```

### 16.4 重启 Gateway

```bash
openclaw gateway restart
```

### 16.5 查看日志

```bash
openclaw logs --limit 50 2>&1 | grep chatclaw
```

### 16.6 检查端口占用

HTTP 和 WebSocket 共用 `9788` 端口，WebSocket 路径为 `/ws`。

```bash
lsof -i :9788 | grep LISTEN
kill <PID>
```

## 17. 技术栈

- **运行时**: Node.js >= 22
- **核心依赖**: `openclaw`, `ws`, `axios`, `zod`, `sql.js`
- **开发依赖**: `typescript`, `vitest`
- **认证**: Argon2 密码哈希 + Bearer Token（HTTP）/ `?token=`（WebSocket）

---

*文档版本: v6.2 | 更新日期: 2026-04-17*
