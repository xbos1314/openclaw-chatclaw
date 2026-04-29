---
name: chatclaw-miniprogram
description: |
  ChatClaw 小程序技能。当用户要求创建、修改、完善小程序时使用。
  统一通过 chatclaw_miniprogram 工具获取项目目录、更新项目状态和推送完成消息。
---

# ChatClaw 小程序技能

## 强制规则

1. `accountId` 必须使用真实账号 ID；需要智能体上下文时单独传 `agentId`。
2. 创建新项目时，必须先调用 `chatclaw_miniprogram.create`。
3. 修改已有项目时，必须先调用 `chatclaw_miniprogram.get`。
4. 只能在工具返回的 `project_dir` 内及其子目录修改文件。
5. 禁止访问、读取、写入项目目录外的任何路径。
6. 项目技术栈固定为：Node + Vue + SQLite。
7. 必须维护：
   - `README.md`
   - `docs/requirement.md`
   - `docs/architecture.md`
   - `docs/database.md`
   - `docs/api.md`
   - `docs/deploy.md`
8. 如果请求里带有 `task_id`，则在 `create`、`set_ready`、`set_failed` 时都必须原样传入同一个 `task_id`。
9. 前端功能、页面、样式、交互修改必须优先修改 `app/` 源码目录。
10. 后端接口、业务逻辑、鉴权、会话能力修改必须优先修改 `server/` 源码目录。
11. `dist/` 是构建产物目录，默认禁止直接编辑；只有无法构建时才允许临时修补，并且必须同步回源码目录。
12. 前端调用项目后端时，必须统一使用 `/api/miniprogram/{appId}/...` 前缀，或使用 `baseApi + 子路径`；禁止直接写 `/api/...` 裸路径。
12.1. 网关内置文件能力统一走 `baseApi + '/file/...'`：
   - 上传：`POST baseApi + '/file/upload'`
   - 预览：`GET baseApi + '/file/{fileId}'`
   - 下载：`GET baseApi + '/file/{fileId}?download=1'`
   - 删除物理文件：`DELETE baseApi + '/file/{fileId}'`
   - 上传请求体 JSON 示例：
     ```json
     {
       "file_name": "avatar.png",
       "content_type": "image/png",
       "data": "<base64>"
     }
     ```
   - 上传成功响应 JSON 示例：
     ```json
     {
       "code": 0,
       "data": {
         "file_id": "uuid.png",
         "file_name": "avatar.png",
         "content_type": "image/png",
         "file_size": 12345,
         "url": "/api/miniprogram/{appId}/file/uuid.png",
         "preview_url": "/api/miniprogram/{appId}/file/uuid.png",
         "download_url": "/api/miniprogram/{appId}/file/uuid.png?download=1",
         "created_at": 1712345678901
       }
     }
     ```
   - 以上 3 个 `/file/*` 接口当前不检查 token，但要求浏览器先访问当前小程序公开页面以获得小程序会话 Cookie；该 Cookie 的 Path 作用域为 `/api/miniprogram/{appId}/`，可供后续其他网关保留接口复用。同时请求的 `Referer` 必须来自当前小程序页面，且项目已发布为 `ready`
12.2. 文件列表、业务表关联、权限语义、删除前校验必须由项目自己在数据库和自定义接口中维护；不要假设网关提供文件列表接口。
13. 项目后端必须直接在 `server/index.js` 导出 `handle(req, ctx)`，并按 `req.path` 子路径处理请求，例如 `/qrcode/generate`；禁止创建 `express()`、`Router()`、`app.listen()` 等独立服务封装。
14. 在 `server/` 中禁止写 `/api/miniprogram/{appId}/...` 或 `/miniprogram/...` 这类网关全路径；这些前缀只属于网关，项目后端内部只处理子路径。
15. 如果需要构建项目，禁止自行运行 `npm run build`、`vite build`、`npm install` 等本地构建命令；必须调用 `chatclaw_miniprogram.build`。
16. 如果修改了 `app/` 下的前端源码或构建配置，必须调用 `chatclaw_miniprogram.build`，确保 `dist/` 已同步更新。
17. 创建成功后或修改前，必须先查看并遍历当前项目代码和目录结构，至少检查 `README.md`、`docs/`、`app/`、`server/`、`data/` 的现状，再开始改动。
18. 创建或修改完成后，在 `build` 和 `set_ready` 之前，必须调用 `chatclaw_miniprogram.validate_project` 检查项目前后端是否符合规范。
19. 成功后必须调用 `chatclaw_miniprogram.update` 和 `chatclaw_miniprogram.set_ready`。
20. 失败时必须调用 `chatclaw_miniprogram.set_failed`。
21. 当你真正开始一次新的项目修改时，应调用 `chatclaw_miniprogram.create_task` 写入任务记录。
22. 当该次修改完成或失败时，应调用 `chatclaw_miniprogram.update_task` 更新同一条任务记录状态。

## 两种消息语义必须区分

### 1. 小程序上下文发送

适用场景：
- 用户只是把某个现有小程序发送给你
- 用户希望你先知道这是哪个项目
- 用户希望你先读取项目现状，再继续沟通

你应该做的事：
1. 调用 `chatclaw_miniprogram.get`
2. 阅读项目当前信息、README、docs、目录结构、访问方式
3. 向用户总结当前项目状态、已有能力、可继续完善方向
4. 等待用户给出明确修改要求

你此时**不应该**做的事：
- 不要调用 `create_task`
- 不要调用 `update_task`
- 不要调用 `update`
- 不要调用 `set_ready`
- 不要调用 `set_failed`
- 不要修改项目文件
- 不要创建新的任务记录

判断信号：
- 通常消息语义是“发送小程序给智能体”
- 这是建立上下文，不是正式开始改项目

### 2. 正式继续完善任务

适用场景：
- 用户已经明确提出要修改什么
- 用户要求你新增、调整、修复、重构某些功能
- 你已经准备开始实际改动项目文件

你应该做的事：
1. 调用 `chatclaw_miniprogram.get`
2. 在开始实际改动前调用 `chatclaw_miniprogram.create_task`
3. 修改项目文件与文档
   - 前端改 `app/`
   - 后端改 `server/`
   - 不要直接改 `dist/`
   - 前端请求项目后端时必须走 `/api/miniprogram/{appId}/...`
   - 若涉及附件上传、预览或物理删除，优先复用 `baseApi + '/file/...'` 网关保留接口
   - 若需要文件列表、业务关联或删除校验，必须在项目自己的数据库和自定义接口中实现
4. 如有需要调用 `chatclaw_miniprogram.build`
5. 调用 `chatclaw_miniprogram.update`
6. 成功时调用 `chatclaw_miniprogram.set_ready`
7. 最后调用 `chatclaw_miniprogram.update_task` 标记 `completed`
8. 若失败，调用 `chatclaw_miniprogram.set_failed` 并把 `update_task` 标记为 `failed`

判断信号：
- 用户提出了明确改动目标
- 你即将实际修改项目代码、配置、文档或数据结构

## 创建流程

1. 阅读用户需求与备注
2. 调用 `chatclaw_miniprogram.create`
   - 传入 `accountId`
   - 若请求提供了 `task_id`，必须一并传入
3. 根据返回的目录路径生成 README、docs、Node + Vue + SQLite 项目
   - 前端源码放在 `app/`
   - 后端源码放在 `server/`
   - 不要把 `dist/` 当作源码目录
   - 前端访问后端统一使用 `/api/miniprogram/{appId}/...`
   - 如需文件上传/预览/物理删除，直接使用 `baseApi + '/file/...'`，并按上面的 JSON 请求体和 `{ code, data }` 响应结构处理，不要在 `server/index.js` 中重复封装一套上传网关
   - `server/index.js` 必须直接实现 `handle(req, ctx)`，后端路由只匹配子路径，例如 `/generate`，不要写完整网关前缀
4. 先查看并遍历当前项目代码和目录结构，确认模板实际生成结果
5. 调用 `chatclaw_miniprogram.validate_project`
6. 只能调用 `chatclaw_miniprogram.build` 构建前端产物到 `dist/`，不要自行执行 `npm`/`vite` 构建命令
7. 调用 `chatclaw_miniprogram.update`
8. 调用 `chatclaw_miniprogram.set_ready`
   - 若请求提供了 `task_id`，必须一并传入

## 修改流程

1. 读取 `app_id`
2. 调用 `chatclaw_miniprogram.get`
3. 先判断这次是“上下文发送”还是“正式继续完善任务”
4. 如果只是上下文发送：总结当前状态并等待用户继续要求，不做任何项目修改
5. 如果是正式继续完善任务：检查现有 README、docs、项目结构，并根据新需求更新项目
   - 前端需求优先修改 `app/`
   - 后端需求优先修改 `server/`
   - `dist/` 只通过 build 更新
   - 前端接口地址不得绕开 `/api/miniprogram/{appId}/...`
   - 对于文件上传、预览、物理删除，优先复用网关保留的 `/file/*` 接口，并按上面的 JSON 请求体和 `{ code, data }` 响应结构读写返回值
   - 如果项目需要附件列表或业务记录关联，必须在项目自己的存储层中维护文件元数据
   - `server/index.js` 不得创建 Express 独立服务，必须直接按 `req.path` 子路径返回结果
6. 开始实际改动前，先遍历并阅读当前项目代码，而不是凭记忆直接修改
7. 开始实际改动前，调用 `chatclaw_miniprogram.create_task`
8. 调用 `chatclaw_miniprogram.validate_project`
9. 若修改了 `app/` 或构建配置，调用 `chatclaw_miniprogram.build`，不要自行执行 `npm`/`vite` 构建命令
10. 同步更新 docs
11. 调用 `chatclaw_miniprogram.update`
12. 调用 `chatclaw_miniprogram.set_ready`
   - 若请求提供了 `task_id`，必须一并传入
13. 最后调用 `chatclaw_miniprogram.update_task` 将该任务标记为 `completed`；失败则标记为 `failed`

## 结构校验工具

- `chatclaw_miniprogram.validate_project`
  - 用途：检查项目是否符合前后端结构规范，尤其是：
    - 前端是否错误使用裸 `/api/...`
    - 前端调用的自定义接口是否与 `server/index.js` 匹配
    - `server/index.js` 是否正确导出 `handle(req, ctx)`
    - 是否错误生成了独立 `express.listen(...)` 服务或 `express()/Router()` 包装层
    - `server/index.js` 是否错误编写了 `/api/miniprogram/{appId}/...` 全路径路由，而不是子路径
  - 约束：创建和修改任务在 `build` / `set_ready` 前都必须调用一次

- `chatclaw_miniprogram.build`
  - 用途：由插件统一安装依赖、构建前端产物、reload 项目后端、执行发布前校验
  - 约束：智能体不得绕过该工具自行执行 `npm install`、`npm run build`、`vite build` 等命令

## 任务记录工具

- `chatclaw_miniprogram.create_task`
  - 用途：当你真正开始一次新的修改、重构、构建修复时，创建任务记录
  - 常用参数：
    - `accountId`
    - `app_id`
    - `task_type`：建议用 `manual_update`
    - `task_status`：建议用 `running`
    - `prompt`
    - `notes`

- `chatclaw_miniprogram.update_task`
  - 用途：更新同一条任务记录的状态、说明、错误信息
  - 常用参数：
    - `accountId`
    - `task_id`
    - `task_status`
    - `prompt`
    - `notes`
    - `error`
