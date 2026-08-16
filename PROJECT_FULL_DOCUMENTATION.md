# CyImagePro — 项目完整技术文档

> **版本**: 3.0.4 | **产品名**: CyImagePro | **标识符**: com.gptimage.batch-generator
> **仓库**: https://github.com/Gicce/GPT_Image_2_Application
> **生成日期**: 2026-05-31

---

## 一、项目概述

CyImagePro 是一款基于 **Tauri 2 + React 18 + Rust** 构建的桌面端 AI 图片批量生成与编辑工具。它集成了 GPT-Image-2 图片生成/编辑 API、remove.bg 去背景服务、OpenAI 兼容的 Agent 智能体对话系统，以及用户账户/充值/退款等商业化功能。

### 核心能力

| 能力 | 说明 |
|------|------|
| 文生图 (text-to-image) | 通过 GPT-Image-2 API 批量生成图片 |
| 图生图 (image-to-image) | 上传源图 + prompt 进行编辑 |
| 去背景 (remove background) | 调用 remove.bg API 提取透明背景 |
| Agent 对话 | 基于 OpenAI 兼容 API 的智能体聊天，支持意图识别、模板匹配、多轮对话 |
| 图片理解 (vision) | 通过官方 Vision API 理解图片内容 |
| 图库搜索 | 基于自然语言的本地图片库语义搜索 |
| 模板系统 | 任务模板 + 风格模板，支持关键词/LLM/混合匹配 |
| 账户系统 | 注册/登录/充值/退款/用量统计 |
| 自动更新 | Tauri Updater + GitHub Releases |

---

## 二、技术栈

### 前端

| 技术 | 版本 | 用途 |
|------|------|------|
| React | ^18.3.1 | UI 框架 |
| TypeScript | ^5.6.0 | 类型安全 |
| Vite | ^6.0.0 | 构建工具 |
| Zustand | ^5.0.0 | 状态管理 |
| Recharts | ^3.8.1 | 图表 (用量统计) |
| marked | ^18.0.3 | Markdown 渲染 |
| highlight.js | ^11.11.1 | 代码高亮 |
| qrcode | ^1.5.4 | 二维码生成 (支付) |
| @tauri-apps/api | ^2 | Tauri 前端 API |
| @tauri-apps/plugin-dialog | ^2 | 文件选择对话框 |
| @tauri-apps/plugin-updater | ^2 | 自动更新 |
| @tauri-apps/plugin-shell | ^2 | Shell 操作 |
| @tauri-apps/plugin-process | ^2.3.1 | 进程管理 |

### 后端 (Rust / Tauri)

| 技术 | 版本 | 用途 |
|------|------|------|
| tauri | 2 | 桌面框架 |
| reqwest | 0.12 | HTTP 客户端 (native-tls) |
| tokio | 1 | 异步运行时 |
| serde / serde_json | 1 | 序列化 |
| rusqlite | 0.32 (bundled) | SQLite 数据库 (模板存储) |
| image | 0.25 | 图片处理/缩略图 |
| base64 | 0.22 | Base64 编解码 |
| uuid | 1 (v4) | ID 生成 |
| chrono | 0.4 | 时间处理 |
| md5 | 0.7 | 缩略图缓存哈希 |
| opener | 0.7 | 打开文件/目录 |
| once_cell | 1 | 全局静态 |
| futures-util | 0.3 | SSE 流解析 |

---

## 三、项目结构

```
GPT_Image_2_Application/
├── .github/workflows/
│   └── release.yml              # GitHub Actions 自动发布
├── public/
│   ├── logo.ico / logo.jpg / logo.png
│   └── wechat-qr.jpg            # 微信二维码
├── src/                          # 前端源码
│   ├── main.tsx                  # 入口
│   ├── App.tsx                   # 根组件 (路由/主题/认证)
│   ├── App.css                   # 全局样式 + 主题变量
│   ├── types/
│   │   ├── index.ts              # 所有 TypeScript 类型定义
│   │   └── tauri.d.ts            # Tauri API 类型声明
│   ├── services/
│   │   ├── api.ts                # Tauri invoke 封装
│   │   ├── serverApi.ts          # 远程服务器 API (认证/充值/退款)
│   │   └── updateService.ts      # 更新检查服务
│   ├── store/
│   │   ├── useAuthStore.ts       # 认证状态
│   │   ├── useChatStore.ts       # 聊天/对话状态
│   │   ├── useDraftStore.ts      # Agent 任务草稿状态
│   │   ├── useImageStore.ts      # 图片库状态
│   │   ├── useSettingsStore.ts   # 设置状态
│   │   ├── useTaskStore.ts       # 任务队列状态
│   │   └── useUpdateStore.ts     # 更新状态
│   ├── utils/
│   │   ├── agentConfig.ts        # Agent 配置工具
│   │   ├── agentIntent.ts        # 意图识别工具
│   │   ├── errors.ts             # 错误处理/格式化
│   │   └── agent/
│   │       ├── agentActionRouter.ts   # Agent 动作路由
│   │       ├── agentPatterns.ts       # Agent 模式匹配
│   │       ├── galleryCriteria.ts     # 图库搜索条件构建
│   │       ├── intentClassifier.ts    # 意图分类器
│   │       └── templateCache.ts       # 模板缓存
│   ├── components/               # 通用组件
│   │   ├── Sidebar.tsx/css       # 侧边栏导航
│   │   ├── ContextMeter.tsx/css  # 上下文窗口计量器
│   │   ├── MarqueeNotice.tsx/css # 滚动公告
│   │   ├── UpdateNotification.tsx/css  # 更新通知
│   │   ├── VersionModal.tsx/css  # 版本/更新弹窗
│   │   ├── TokenField.tsx/css    # Token 输入/显示
│   │   ├── TokenInfoDialog.tsx/css    # Token 信息弹窗
│   │   ├── SuccessDialog.tsx/css # 成功提示弹窗
│   │   ├── DeleteConvDialog.tsx/css   # 删除对话确认
│   │   ├── DeleteTaskDialog.tsx/css   # 删除任务确认
│   │   ├── EditTaskModal.tsx/css # 编辑任务弹窗
│   │   ├── ErrorBoundary.tsx     # 错误边界
│   │   └── AccountUsageCharts.tsx # 用量图表
│   └── pages/                    # 页面组件
│       ├── AgentChat.tsx         # Agent 聊天入口 (re-export Chat)
│       ├── Chat.tsx / Chat.css   # 主聊天页 (2302行, 核心页面)
│       ├── TaskQueue.tsx/css     # 任务队列
│       ├── Gallery.tsx/css       # 图片库
│       ├── History.tsx/css       # 历史记录
│       ├── Settings.tsx/css      # 设置页
│       ├── About.tsx/css         # 关于页
│       ├── Account.tsx/css       # 账户/充值/退款
│       ├── Auth.tsx/css          # 登录/注册
│       ├── CreateTask.tsx/css    # 创建任务
│       └── ImageEdit.tsx/css     # 图片编辑
├── src-tauri/                    # Rust 后端
│   ├── Cargo.toml                # Rust 依赖
│   ├── .cargo/config.toml        # Rust 编译配置
│   ├── build.rs                  # Tauri 构建脚本
│   ├── tauri.conf.json           # Tauri 应用配置
│   ├── capabilities/default.json # Tauri 权限声明
│   ├── icons/                    # 应用图标
│   ├── WebView2Loader.dll        # Windows WebView2
│   └── src/
│       ├── main.rs               # Rust 入口
│       ├── lib.rs                # Tauri 应用初始化 + 命令注册
│       ├── models.rs             # 所有 Rust 数据模型
│       ├── commands.rs           # 所有 Tauri 命令实现
│       ├── storage.rs            # 数据持久化 (JSON + SQLite)
│       └── task_runner.rs        # 任务执行引擎
├── index.html                    # HTML 入口
├── package.json                  # Node 依赖
├── tsconfig.json                 # TypeScript 配置
└── vite.config.ts                # Vite 构建配置
```

---

## 四、架构设计

### 4.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│                    Tauri Window                       │
│  ┌──────────┐  ┌──────────────────────────────────┐  │
│  │          │  │         React Frontend            │  │
│  │ Sidebar  │  │  ┌─────┐ ┌──────┐ ┌───────────┐  │  │
│  │          │  │  │Chat │ │Queue │ │ Gallery   │  │  │
│  │ - Agent  │  │  └─────┘ └──────┘ └───────────┘  │  │
│  │ - Queue  │  │  ┌──────┐ ┌─────┐ ┌───────────┐  │  │
│  │ - Gallery│  │  │Acct  │ │Sett │ │  About    │  │  │
│  │ - Hist   │  │  └──────┘ └─────┘ └───────────┘  │  │
│  │ - Sett   │  │                                    │  │
│  │ - About  │  │  Zustand Stores ←→ Tauri invoke   │  │
│  │ - Acct   │  │         ↕                          │  │
│  └──────────┘  │    serverApi.ts → Remote Server    │  │
│                └──────────────────────────────────┘  │
│                         ↕ tauri::command              │
│  ┌──────────────────────────────────────────────────┐│
│  │              Rust Backend                         ││
│  │  commands.rs ←→ storage.rs (JSON + SQLite)       ││
│  │  task_runner.rs (异步任务执行)                     ││
│  │  reqwest → packyapi.com / remove.bg / GitHub     ││
│  └──────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────┘
```

### 4.2 数据流

1. **用户操作** → React 组件 → Zustand Store 更新
2. **持久化操作** → Store 调用 `api.ts` (tauri invoke) → Rust commands → storage.rs (JSON/SQLite)
3. **API 调用** → Rust reqwest → 外部 API (packyapi.com / remove.bg)
4. **远程服务** → `serverApi.ts` (fetch) → 后端服务器 (认证/充值/退款)
5. **任务执行** → task_runner.rs 每 500ms 轮询 pending 任务 → 逐个执行 → emit 事件更新前端

### 4.3 主题系统

- 支持 `light` / `dark` / `system` 三种模式
- CSS 变量定义在 `App.css` 的 `[data-theme="light"]` / `[data-theme="dark"]`
- `App.tsx` 中通过 `matchMedia` 监听系统主题变化

---

## 五、核心模块详解

### 5.1 Rust 后端

#### 5.1.1 应用初始化 (lib.rs)

```rust
// 注册 Tauri 插件
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_updater::Builder::new().build())

// 启动任务执行线程 (500ms 轮询)
std::thread::spawn(|| {
    let rt = tokio::runtime::Runtime::new().expect("...");
    rt.block_on(async {
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            if shutdown_flag.load(Ordering::Relaxed) { break; }
            task_runner::process_next_task(&app_handle).await;
        }
    });
});
```

#### 5.1.2 Tauri 命令清单

| 命令 | 功能 |
|------|------|
| `get_settings` / `save_settings` | 读写应用设置 |
| `run_agent_request` | Agent 意图识别/对话 (interpret/chat 模式) |
| `check_agent_endpoints` | 检测 Agent 各端点可用性 (7项检测) |
| `understand_chat_images` | 官方 Vision API 图片理解 |
| `get_agent_task_templates` / `save/delete/toggle` | 任务模板 CRUD |
| `get_agent_style_templates` / `save/delete/toggle` | 风格模板 CRUD |
| `get_agent_template_logs` / `append` | 模板日志 |
| `export_agent_templates` / `import` | 模板导入导出 |
| `export_agent_template_draft` | 模板草稿导出 (供 Agent 编辑) |
| `get_tasks` / `create_task` / `cancel_task` / `retry_task` | 任务管理 |
| `get_images` / `rescan_image_library` / `delete_image` | 图片库管理 |
| `get_image_meta` / `update_image_index` | 图片元数据 |
| `read_thumbnail` / `read_image_data` | 读取图片数据 (缩略图/完整) |
| `open_file` / `open_folder` | 打开文件/目录 |
| `select_directory` / `select_image_file` / `select_text_file` | 文件选择对话框 |
| `get_conversations` / `save_conversations` / `save_conversation` | 对话持久化 |
| `save_chat_image` / `save_image_as` | 保存图片 |
| `remove_background` | 去背景 (remove.bg) |
| `chat_generate_image` / `chat_edit_image` | 聊天内图片生成/编辑 (SSE 流式) |
| `delete_task` | 删除任务 (可选删除关联图片) |
| `fetch_releases` | 获取 GitHub Releases |

#### 5.1.3 任务执行引擎 (task_runner.rs)

**执行流程**:
1. 每 500ms 轮询 `pending` 状态的任务
2. 标记为 `running`，emit `task-updated` 事件
3. 检查 API Token、创建输出目录
4. 逐个执行子任务 (sub_task):
   - `generate` → POST `packyapi.com/v1/images/generations` (JSON, model=gpt-image-2)
   - `edit` → POST `packyapi.com/v1/images/edits` (multipart, model=gpt-image-2)
   - `remove_background` → POST `api.remove.bg/v1.0/removebg` (multipart)
5. 每个子任务完成后更新状态，emit 事件
6. 支持取消检测 (每轮检查 cancelled 状态)
7. 最终汇总 success_count / failed_count

**批量任务支持**:
- `execution_mode`: `single` (单次) / `batch` (批量)
- `batch_strategy`: `repeat_same` (重复相同) / `variant_set` (变体集) / `multi_input` (多输入)
- `batch_items`: 每项可自定义 `prompt_delta` / `prompt_override` / `source_images`

**effective_prompt 逻辑**:
```
1. 如果 batch_items[index] 有 prompt_override 且非空 → 使用 override
2. 否则 base = final_prompt || prompt
3. 如果 batch_items[index] 有 prompt_delta → base + "\n" + delta
```

#### 5.1.4 Agent 请求处理 (commands.rs)

**两种模式**:

1. **interpret 模式** (意图识别):
   - 发送系统 prompt 要求返回 JSON
   - JSON 字段: intent, confidence, needs_clarification, clarification_question, recommended_action, should_propose_execution, final_prompt, final_negative_prompt, api_kind
   - 解析响应中的 JSON 对象 (支持 markdown 代码块包裹)

2. **chat 模式** (多轮对话):
   - 支持多段 content (text + image_url)
   - 透传 system_prompt + messages
   - 返回纯文本 reply

**端点检测** (7 项):
1. `chat` — 基础对话
2. `chat_with_system` — 带 system prompt 的对话
3. `chat_multimodal` — 多模态 (图片+文本) 对话
4. `official_vision` — 官方 Vision API (Responses API)
5. `interpret` — JSON 输出能力
6. `generation` — 文生图就绪
7. `edit` — 图生图就绪

**错误分类**:
- `connect` / `timeout` / `auth` / `rate_limit` / `server`
- `invalid_response` / `invalid_request` / `model_error`
- `multimodal_unsupported` / `json_output_unsupported`
- `upstream_api` / `not_configured` / `vision_error`

**重试机制**: 对 5xx / connect / timeout 错误自动重试 1 次

#### 5.1.5 聊天内图片生成 (SSE 流式)

使用 OpenAI Responses API 的 `image_generation` tool:
```json
{
  "model": "gpt-image-2",
  "stream": true,
  "input": [{ "role": "user", "content": [...] }],
  "tools": [{ "type": "image_generation" }]
}
```
- `chat_generate_image`: 纯文本 prompt 生成
- `chat_edit_image`: 带 input_image 的编辑
- `parse_sse_for_image`: 解析 SSE 流，递归搜索 `result`/`b64_json`/`image_data` 字段

#### 5.1.6 数据存储 (storage.rs)

**双存储策略**:
- **JSON 文件**: settings.json, tasks.json, images.json, conversations.json (兼容旧版)
- **SQLite 数据库**: app.db (模板相关数据，新架构)

**SQLite 表结构**:
- `kv_store` — 通用键值存储 (JSON 迁移中间层)
- `migrations` — 迁移记录
- `agent_task_templates` — 任务模板 (29 列)
- `agent_style_templates` — 风格模板 (14 列)
- `agent_template_logs` — 模板使用日志 (14 列)

**并发控制**: `TASK_LOCK` / `IMAGE_LOCK` (Mutex) 保护 tasks.json / images.json 的读写

**缩略图缓存**: `data_dir/thumbs/` 目录，以 MD5(path) 为文件名，源文件更新时自动失效

**图片库同步** (`sync_images`):
1. 扫描 `library_input_dir` + `default_output_dir` 下所有 png/jpg/jpeg/webp
2. 与已有记录比对 (按路径)
3. 新文件创建 ImageRecord，已有文件更新 last_seen_at
4. 不存在的文件标记 missing
5. 按 source_kind 分类: library_input / output / chat / postprocess

#### 5.1.7 默认模板种子数据

**任务模板** (5 个):
1. `general_text_to_image` — 通用文生图
2. `img2img_merge_person_into_scene` — 人物融入场景
3. `ecommerce_main_image` — 电商主图
4. `amazon_a_plus_scene` — 亚马逊 A+ 场景图
5. `remove_background_subject` — 主体去背景

**风格模板** (5 个):
1. `realistic_photo_style` — 写实摄影
2. `premium_commercial_style` — 高端商业广告
3. `cyberpunk_style` — 赛博朋克风格
4. `clean_ecommerce_style` — 干净电商风
5. `iphone_ecommerce_style` — iPhone 风格电商 (UPSERT 更新)

---

### 5.2 前端核心

#### 5.2.1 类型系统 (types/index.ts)

**核心类型**:

| 类型 | 说明 |
|------|------|
| `Settings` | 应用设置 (27 个字段) |
| `Task` / `SubTask` | 任务/子任务 |
| `TaskBatchItem` | 批量任务项 |
| `ImageRecord` | 图片记录 |
| `ChatMessage` / `ChatConversation` | 聊天消息/对话 |
| `AgentProposal` | Agent 提案 |
| `AgentTaskDraft` | Agent 任务草稿 (25 个字段) |
| `AgentTaskTemplate` | 任务模板 (29 个字段) |
| `AgentStyleTemplate` | 风格模板 (14 个字段) |
| `AgentTemplateLog` | 模板日志 |
| `GallerySearchState` / `GallerySearchResult` | 图库搜索状态/结果 |
| `AgentEndpointCheckResult` | 端点检测结果 (7 项) |
| `AgentRunRequestResult` | Agent 请求结果 |
| `VisionUnderstandResult` | 图片理解结果 |
| `ChatAttachment` | 聊天附件 |

**常量**:
- `SIZES`: 1024x1024, 1792x1024, 1024x1792
- `QUALITIES`: auto, high, medium, low
- `FORMATS`: png, jpeg, webp
- `TASK_TEMPLATE_CATEGORIES`: generate, edit, remove_background, upscale, gallery
- `TASK_TEMPLATE_SCENES`: general, ecommerce_main, amazon_a_plus, brand_scene, poster, social_ad, img2img_merge, background_replace
- `TASK_TEMPLATE_INTENTS`: image_generate, image_edit, remove_background, upscale, gallery_search
- `STYLE_TEMPLATE_GROUPS`: visual_style, lighting, camera, mood, platform

#### 5.2.2 状态管理 (Zustand Stores)

**useAuthStore** — 认证状态:
- `isLoggedIn`, `user`, `token`, `groupTypeMap`
- `login()`, `logout()`, `refreshUser()`
- `authPromptVisible` — 全局登录提示
- `requestedPage` — 登录后跳转目标页

**useChatStore** — 聊天状态:
- `conversations`, `activeConversationId`
- 对话 CRUD、消息发送
- Agent 交互流程管理

**useDraftStore** — Agent 任务草稿:
- `activeDraft` — 当前活跃草稿
- 草稿阶段管理 (collecting → clarifying → variant_planning → ready_for_proposal → proposed → confirmed → queued)

**useImageStore** — 图片库:
- `images`, `loading`
- 图片加载、删除、索引更新

**useSettingsStore** — 设置:
- `settings` (27 个字段)
- `loadSettings()`, `updateSettings()`
- 主题管理

**useTaskStore** — 任务队列:
- `tasks`, `loading`
- 任务创建、取消、重试、删除

**useUpdateStore** — 更新:
- `updateAvailable`, `updateInfo`, `downloading`, `downloadProgress`
- `checkUpdate()`, `installUpdate()`

#### 5.2.3 服务层

**api.ts** — Tauri invoke 封装:
- 所有 Tauri 命令的 TypeScript 封装
- 统一错误处理

**serverApi.ts** — 远程服务器 API:
- 基础 URL: `settings.server_url` (默认 http://localhost:8000)
- 认证: Bearer token
- 端点:
  - `POST /auth/login` — 登录
  - `POST /auth/register` — 注册
  - `POST /auth/verify-email` — 邮箱验证
  - `POST /auth/forgot-password` — 忘记密码
  - `GET /auth/me` — 获取用户信息
  - `GET /models` — 获取模型列表
  - `GET /balance` — 获取余额
  - `POST /payment/create` — 创建支付订单
  - `GET /payment/status/:id` — 查询支付状态
  - `POST /payment/refund` — 申请退款
  - `GET /payment/refund-status/:id` — 查询退款状态
  - `GET /usage` — 获取用量记录
  - `GET /orders` — 获取订单列表
  - `GET /pricing` — 获取定价信息
  - `POST /trial/upgrade` — 试用升级

**updateService.ts** — 更新检查:
- 使用 `@tauri-apps/plugin-updater`
- GitHub Releases 端点: `https://github.com/Gicce/GPT_Image_2_Application/releases/latest/download/latest.json`

#### 5.2.4 Agent 工具链 (utils/agent/)

**intentClassifier.ts** — 意图分类:
- 基于关键词的快速分类
- 支持: chat, gallery_search, image_understanding, image_generate, image_edit, remove_background, upscale

**agentActionRouter.ts** — 动作路由:
- 根据意图分发到不同的处理流程
- 管理草稿状态转换

**agentPatterns.ts** — 模式匹配:
- 正则/关键词模式匹配
- 提取用户输入中的结构化信息

**galleryCriteria.ts** — 图库搜索条件:
- 从自然语言提取搜索条件
- 时间范围、主体、风格、方向、用途

**templateCache.ts** — 模板缓存:
- 缓存任务/风格模板
- 关键词匹配、优先级排序

#### 5.2.5 页面组件

**Chat.tsx** (2302 行) — 核心聊天页面:
- 左侧: 对话列表 (虚拟滚动)
- 右侧: 消息区 + 输入区
- 功能:
  - Markdown 渲染 (代码高亮 + 复制按钮)
  - Callout 块 (warning/danger/important/note/tip)
  - 图片附件 (上传/粘贴/图库选择)
  - Agent 提案卡片 (确认/取消/编辑)
  - 图库搜索面板
  - 模型选择器
  - 上下文窗口计量器
  - 流式响应 (打字机效果)
  - 推理过程展示 (thinking animation)

**Settings.tsx** (1251 行) — 设置页面:
- 默认生成参数 (尺寸/质量/格式/服务器地址)
- Agent 配置 (头像/模型/地址/Token/上下文窗口/系统提示词)
- 端点检测 (7 项检测 + 结果展示)
- 后处理工具 (remove.bg / Topaz)
- 外观 (主题选择)
- 模板中心 (任务模板/风格模板/导入导出/日志)

**Account.tsx** (1074 行) — 账户页面:
- 用户信息卡片 (头像管理)
- 充值面板 (按分组: image/agent/postprocess)
- 支付二维码 + 轮询
- 用量记录 + 图表
- 订单历史 + 退款
- 定价弹窗
- 试用升级

**Auth.tsx** (322 行) — 认证组件:
- 登录/注册切换
- 邮箱验证码
- 忘记密码
- 试用/正式账户选择

**TaskQueue.tsx** (248 行) — 任务队列:
- 任务卡片 (状态徽章/进度条/子任务错误)
- 操作: 取消/重试/编辑重发/删除

**Gallery.tsx** (180 行) — 图片库:
- 按来源分组的图片网格
- 缩略图懒加载 + 无限滚动
- 预览弹窗

**History.tsx** (284 行) — 历史记录:
- 左侧任务列表 + 右侧详情
- 任务参数/源图/结果图

**ImageEdit.tsx** (423 行) — 图片编辑:
- 源图上传/图库选择
- 图库选择器弹窗 (3x3/4x4 布局)
- HD 悬停预览

**CreateTask.tsx** (213 行) — 创建任务:
- 批量文生图表单
- 参数选择 + 输出目录

**About.tsx** (149 行) — 关于页面:
- 公司信息 (晨阳电脑)
- 业务服务/产品特性
- 联系方式 + 微信二维码

---

## 六、API 端点汇总

### 6.1 外部 API (Rust 端调用)

| 端点 | 方法 | 用途 |
|------|------|------|
| `https://www.packyapi.com/v1/images/generations` | POST | 文生图 (JSON) |
| `https://www.packyapi.com/v1/images/edits` | POST | 图生图 (multipart) |
| `https://www.packyapi.com/v1/responses` | POST | Vision 理解 / 聊天内生图 (SSE) |
| `https://www.packyapi.com/v1/chat/completions` | POST | Agent 对话/意图识别 |
| `https://api.remove.bg/v1.0/removebg` | POST | 去背景 (multipart) |
| `https://api.github.com/repos/Gicce/GPT_Image_2_Application/releases` | GET | 版本发布信息 |

### 6.2 远程服务器 API (前端 fetch)

基础 URL: `settings.server_url` (默认 `http://localhost:8000`)

| 端点 | 方法 | 用途 |
|------|------|------|
| `/auth/login` | POST | 登录 |
| `/auth/register` | POST | 注册 |
| `/auth/verify-email` | POST | 邮箱验证 |
| `/auth/forgot-password` | POST | 忘记密码 |
| `/auth/me` | GET | 用户信息 |
| `/models` | GET | 模型列表 |
| `/balance` | GET | 余额查询 |
| `/payment/create` | POST | 创建支付 |
| `/payment/status/:id` | GET | 支付状态 |
| `/payment/refund` | POST | 申请退款 |
| `/payment/refund-status/:id` | GET | 退款状态 |
| `/usage` | GET | 用量记录 |
| `/orders` | GET | 订单列表 |
| `/pricing` | GET | 定价信息 |
| `/trial/upgrade` | POST | 试用升级 |

---

## 七、数据模型

### 7.1 Settings (设置)

```typescript
interface Settings {
  token: string;                    // 图片 API Token
  default_size: string;             // 默认尺寸 (1024x1024)
  default_quality: string;          // 默认质量 (auto)
  default_format: string;           // 默认格式 (png)
  default_output_dir: string;       // 默认输出目录
  library_input_dir: string;        // 图库输入目录
  agent_name: string;               // Agent 名称 (CyImage Agent)
  agent_token: string;              // Agent Token
  agent_model: string;              // Agent 模型 (gpt-4o)
  agent_base_url: string;           // Agent 基础 URL
  agent_system_prompt: string;      // Agent 系统提示词
  agent_context_window: number;     // 上下文窗口 (32768)
  ai_avatar_data_url: string;       // AI 头像
  user_avatar_data_url: string;     // 用户头像
  removebg_api_key: string;         // remove.bg API Key
  upscale_provider: string;         // 放大提供商 (disabled/topaz/custom)
  topaz_api_key: string;            // Topaz API Key
  vision_model: string;             // 视觉模型 (gpt-4o)
  chat_token: string;               // 聊天 Token
  chat_model: string;               // 聊天模型
  chat_base_url: string;            // 聊天基础 URL
  chat_system_prompt: string;       // 聊天系统提示词
  server_url: string;               // 服务器 URL (http://localhost:8000)
  notice_enabled: boolean;          // 公告启用 (true)
  theme: string;                    // 主题 (system/light/dark)
}
```

### 7.2 Task (任务)

```typescript
interface Task {
  id: string;
  prompt: string;                   // 基础提示词
  negative_prompt: string;          // 负面提示词
  user_prompt_raw: string;          // 用户原始输入
  final_prompt: string;             // 最终提示词 (优化后)
  final_negative_prompt: string;    // 最终负面提示词
  prompt_optimized: boolean;        // 是否已优化
  agent_intent: string;             // Agent 意图
  task_source: string;              // 来源 (manual/agent)
  size: string;                     // 尺寸
  quality: string;                  // 质量
  output_format: string;            // 输出格式
  count: number;                    // 数量
  status: string;                   // 状态 (pending/running/completed/failed/cancelled)
  created_at: string;               // 创建时间
  output_dir: string;               // 输出目录
  success_count: number;            // 成功数
  failed_count: number;             // 失败数
  sub_tasks: SubTask[];             // 子任务列表
  task_type: string;                // 类型 (generate/edit/remove_background)
  source_images: string[];          // 源图片路径
  execution_mode: string;           // 执行模式 (single/batch)
  batch_strategy: string;           // 批量策略
  task_plan_summary: string;        // 任务计划摘要
  batch_items: TaskBatchItem[];     // 批量项
}
```

### 7.3 AgentTaskDraft (Agent 任务草稿)

```typescript
interface AgentTaskDraft {
  id: string;
  conversation_id: string;
  task_kind: AgentTaskKind;         // gallery_search/image_understanding/image_generate/image_edit/remove_background/upscale
  stage: AgentTaskStage;            // collecting→clarifying→variant_planning→ready_for_proposal→proposed→confirmed→queued→running→completed→failed→cancelled
  execution_mode: TaskExecutionMode;
  batch_strategy?: TaskBatchStrategy;
  task_plan_summary?: string;
  user_prompt_raw: string;
  latest_user_message: string;
  source_images: string[];
  reference_images: string[];
  subject?: string;                 // 主体
  scene?: string;                   // 场景
  style?: string;                   // 风格
  selling_point?: string;           // 卖点
  background_target?: string;       // 背景目标
  edit_target?: string;             // 编辑目标
  keep_constraints: string[];       // 保持约束
  change_constraints: string[];     // 变更约束
  negative_constraints: string[];   // 负面约束
  unresolved_fields: string[];      // 未解决字段
  clarification_questions: string[];// 澄清问题
  matched_task_template_id?: string;
  matched_task_template_name?: string;
  matched_style_template_ids: string[];
  matched_style_template_names?: string[];
  final_prompt: string;
  final_negative_prompt: string;
  recommended_action: string;
  api_kind?: string;                // generation/edit/remove_background/upscale
  variant_plan?: { target_count: number; variation_axis?: string; items: TaskBatchItem[]; };
  confidence: number;
  used_local_fallback: boolean;
  linked_task_id?: string;
  created_at: string;
  updated_at: string;
}
```

### 7.4 AgentTaskTemplate (任务模板)

```typescript
interface AgentTaskTemplate {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;                 // 默认 100
  category: string;                 // generate/edit/remove_background/upscale/gallery
  scene: string;                    // general/ecommerce_main/amazon_a_plus/brand_scene/poster/social_ad/img2img_merge/background_replace
  intent: string;                   // image_generate/image_edit/remove_background/upscale/gallery_search
  match_mode: string;               // keyword/llm_only/hybrid
  trigger_keywords: string[];
  exclude_keywords: string[];
  requires_source_images: boolean;
  min_source_images: number;
  max_source_images: number | null;
  requires_confirmation: boolean;
  allow_auto_execute: boolean;
  clarification_rules: {
    enabled: boolean;
    required_fields: string[];
    fallback_question: string;
  };
  system_prompt: string;
  prompt_template: string;
  negative_prompt_template: string;
  recommended_action_template: string;
  output_schema: {
    final_prompt: boolean;
    final_negative_prompt: boolean;
    recommended_action: boolean;
    clarification_question: boolean;
  };
  notes: string;
  created_at: string;
  updated_at: string;
}
```

### 7.5 AgentStyleTemplate (风格模板)

```typescript
interface AgentStyleTemplate {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  style_group: string;              // visual_style/lighting/camera/mood/platform
  trigger_keywords: string[];
  exclude_keywords: string[];
  style_prompt_fragment: string;    // 风格提示词片段
  negative_prompt_fragment: string; // 负面风格片段
  compatible_intents: string[];     // 兼容的意图
  compatible_scenes: string[];      // 兼容的场景
  notes: string;
  created_at: string;
  updated_at: string;
}
```

---

## 八、Agent 工作流

### 8.1 意图识别流程

```
用户输入 → intentClassifier (关键词快速分类)
         → run_agent_request (interpret 模式, LLM 精确分类)
         → 返回: intent + confidence + needs_clarification + final_prompt + api_kind
```

### 8.2 任务草稿生命周期

```
collecting (收集信息)
  ↓
clarifying (澄清需求)
  ↓
variant_planning (变体规划, 可选)
  ↓
ready_for_proposal (准备提案)
  ↓
proposed (已提案, 等待用户确认)
  ↓
confirmed (已确认)
  ↓
queued (已入队)
  ↓
running (执行中)
  ↓
completed / failed / cancelled
```

### 8.3 模板匹配流程

```
用户输入 → templateCache (关键词匹配)
         → 按 priority 排序
         → 匹配模式: keyword / llm_only / hybrid
         → 返回: matched_task_template + matched_style_templates
         → 组合: prompt_template + style_prompt_fragment → final_prompt
```

### 8.4 聊天内图片生成流程

```
用户在聊天中请求生图
  → Agent 识别意图为 image_generate/image_edit
  → 生成 AgentProposal
  → 用户确认
  → chat_generate_image / chat_edit_image (SSE 流式)
  → 解析 SSE 获取 b64_json
  → 保存到 output_dir/chat/
  → 在聊天中展示生成的图片
```

---

## 九、构建与发布

### 9.1 开发环境

```bash
# 前端开发
npm run dev          # Vite dev server (port 1420)

# Tauri 开发 (前端 + Rust)
npm run tauri dev    # 启动 Tauri 开发窗口

# 构建
npm run build        # 前端构建
npm run tauri build  # 完整构建 (前端 + Rust → 安装包)
```

### 9.2 Vite 构建配置

- 端口: 1420 (strictPort)
- 代码分割策略:
  - `charts-vendor` — recharts
  - `highlight-vendor` — highlight.js
  - `markdown-vendor` — marked
  - `tauri-vendor` — @tauri-apps
  - `qrcode-vendor` — qrcode
  - `shared-vendor` — 其他 node_modules
  - `page-chat` — Chat/AgentChat
  - `page-settings` — Settings
  - `page-account` — Account

### 9.3 Tauri 配置

- 产品名: CyImagePro
- 窗口: 1200x800 (最小 900x600)
- CSP: null (无限制)
- 资源协议: 允许 `**`
- 更新签名公钥: 已配置
- 更新端点: GitHub Releases
- Windows 安装模式: passive (NSIS)
- WebView2: downloadBootstrapper

### 9.4 GitHub Actions 发布

- 触发: push to `release` 分支 / 手动触发
- 运行环境: windows-latest
- 步骤: Node.js LTS → Rust stable → npm install → tauri-action
- 产物: NSIS 安装包
- Tag 格式: `app-v__VERSION__`
- Release: Draft 模式

### 9.5 Rust 编译配置

```toml
[target.x86_64-pc-windows-msvc]
rustflags = ["-C", "link-arg=/IGNORE:4217"]
```

---

## 十、认证与商业化

### 10.1 认证流程

1. 用户打开需认证页面 (agent/queue/account) → 弹出 Auth 组件
2. 登录: email + password → `POST /auth/login` → 获取 token
3. 注册: email + verification_code + password + account_type (trial/normal)
4. Token 存储在 useAuthStore，自动附加到 serverApi 请求头
5. 401 响应 → 全局触发 authPromptVisible → 弹出登录

### 10.2 充值流程

1. 选择分组 (image/agent/postprocess) + 金额
2. `POST /payment/create` → 获取支付 URL
3. 生成二维码 (qrcode 库)
4. 轮询 `GET /payment/status/:id` (3s 间隔)
5. 支付成功 → 刷新余额

### 10.3 退款流程

1. 订单列表中点击退款
2. `POST /payment/refund` → 获取退款 ID
3. 轮询 `GET /payment/refund-status/:id`
4. 退款完成 → 刷新余额

### 10.4 模型分组

- `image` — 图片生成/编辑
- `agent` — Agent 对话
- `postprocess` — 后处理 (去背景/放大)
- `chat` — 聊天

每个分组有独立的余额和定价。

---

## 十一、特殊逻辑

### 11.1 参考绑定详情图检测

`is_reference_bound_detail_task_text()` 检测用户是否在做"模特+产品"参考绑定型详情图:
- 关键词: 详情图/长图/海报/A+图/主图 + 模特/人物/穿搭 + 产品/商品/白底图
- 绑定信号: 根据我提供/基于我提供/参考我提供/保持一致
- 检测到时: 强制 task_type=edit, 要求至少 2 张源图

### 11.2 图片来源分类

- `library_input` — 图库输入目录中的图片
- `output` — 输出目录中的生成图片
- `chat` — 输出目录/chat/ 下的聊天图片
- `postprocess` — 输出目录/transparent/ 下的去背景图片

### 11.3 上下文窗口管理

- `ContextMeter` 组件显示当前对话的 token 使用量
- 超过阈值时显示警告
- 支持上下文摘要压缩

### 11.4 滚动公告

- `MarqueeNotice` 组件从远程获取公告内容
- 水平滚动动画，悬停暂停
- 可关闭

---

## 十二、错误处理

### 12.1 前端错误处理 (errors.ts)

统一错误格式化函数，根据 error_kind 返回用户友好的中文错误消息:
- `connect` → "无法连接服务，请检查网络"
- `timeout` → "请求超时，请稍后重试"
- `auth` → "鉴权失败，请检查 Token"
- `rate_limit` → "请求过于频繁"
- `server` → "上游服务暂时不可用"
- `model_error` → "模型配置不可用"
- `multimodal_unsupported` → "不兼容多模态消息格式"
- `json_output_unsupported` → "不稳定遵循 JSON 输出要求"
- HTTP 状态码: 400/401/402/403/404/429/5xx 各有对应消息

### 12.2 Rust 错误处理

- 所有 Tauri 命令返回 `Result<T, String>`
- HTTP 错误通过 `format_upstream_image_error` / `build_upstream_error_message` 格式化
- 错误分类通过 `classify_upstream_error` / `classify_reqwest_error`
- 重试: 5xx / connect / timeout 自动重试 1 次

---

## 十三、CSS 主题系统

### 13.1 主题变量

```css
[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f5f6fa;
  --text-primary: #1a1a2e;
  --text-secondary: #6b7280;
  --accent: #6366f1;
  --border: #e5e7eb;
  /* ... 更多变量 */
}

[data-theme="dark"] {
  --bg-primary: #0f0f1a;
  --bg-secondary: #1a1a2e;
  --text-primary: #e5e7eb;
  --text-secondary: #9ca3af;
  --accent: #818cf8;
  --border: #2d2d44;
  /* ... 更多变量 */
}
```

### 13.2 主题切换

- `App.tsx` 中监听 `settings.theme` 变化
- `system` 模式: 通过 `matchMedia('(prefers-color-scheme: dark)')` 监听系统主题
- 设置 `document.documentElement.setAttribute('data-theme', ...)`

---

## 十四、关键文件行数统计

| 文件 | 行数 | 说明 |
|------|------|------|
| Chat.tsx | 2302 | 核心聊天页面 |
| Chat.css | 2511 | 聊天页样式 |
| commands.rs | 2053 | Rust 命令实现 |
| storage.rs | 905 | 数据存储 |
| Account.css | 1168 | 账户页样式 |
| Settings.tsx | 1251 | 设置页面 |
| Account.tsx | 1074 | 账户页面 |
| Settings.css | 762 | 设置页样式 |
| models.rs | 513 | Rust 数据模型 |
| task_runner.rs | 538 | 任务执行引擎 |
| types/index.ts | 500 | TypeScript 类型 |
| ImageEdit.tsx | 423 | 图片编辑页 |
| ImageEdit.css | 462 | 图片编辑样式 |
| Auth.tsx | 322 | 认证组件 |
| About.css | 315 | 关于页样式 |
| Auth.css | 307 | 认证样式 |
| VersionModal.css | 310 | 版本弹窗样式 |
| UpdateNotification.css | 239 | 更新通知样式 |
| TaskQueue.tsx | 248 | 任务队列 |
| Chat.css (shared) | 2511 | 聊天样式 |
| History.tsx | 284 | 历史记录 |
| Gallery.tsx | 180 | 图片库 |
| CreateTask.tsx | 213 | 创建任务 |
| App.css | 459 | 全局样式 |
| lib.rs | 92 | Tauri 初始化 |

---

## 十五、依赖关系图

```
App.tsx
├── Sidebar.tsx
│   └── useAuthStore (余额显示)
├── MarqueeNotice.tsx
├── UpdateNotification.tsx
│   └── useUpdateStore
├── Auth.tsx (弹窗)
│   └── serverApi (登录/注册)
├── AgentChat.tsx → Chat.tsx
│   ├── useChatStore
│   ├── useDraftStore
│   ├── useSettingsStore
│   ├── useAuthStore
│   ├── ContextMeter.tsx
│   ├── api.ts (tauri invoke)
│   ├── agentActionRouter.ts
│   ├── intentClassifier.ts
│   ├── templateCache.ts
│   └── galleryCriteria.ts
├── TaskQueue.tsx
│   ├── useTaskStore
│   ├── EditTaskModal.tsx
│   └── DeleteTaskDialog.tsx
├── Gallery.tsx
│   └── useImageStore
├── History.tsx
│   ├── useTaskStore
│   └── useImageStore
├── Settings.tsx
│   ├── useSettingsStore
│   ├── TokenField.tsx
│   ├── TokenInfoDialog.tsx
│   └── api.ts (端点检测/模板管理)
├── Account.tsx
│   ├── useAuthStore
│   ├── serverApi (充值/退款/用量)
│   ├── AccountUsageCharts.tsx
│   └── SuccessDialog.tsx
└── About.tsx
```

---

## 十六、开发注意事项

1. **API 代理**: 所有 OpenAI API 请求通过 `packyapi.com` 代理，不是直连 OpenAI
2. **双 Token 体系**: `token` (图片 API) 和 `agent_token` (Agent API) 可以不同
3. **数据迁移**: storage.rs 同时维护 JSON 文件和 SQLite，JSON 作为备份/兼容
4. **任务执行**: 在独立线程中 500ms 轮询，不是事件驱动
5. **缩略图**: 首次生成后缓存到 thumbs/ 目录，源文件更新时自动重新生成
6. **SSE 流式**: 聊天内图片生成使用 Responses API 的 SSE 流，递归搜索 b64_json
7. **模板种子**: 首次启动时自动插入默认模板，iPhone 风格模板使用 UPSERT 始终更新
8. **参考绑定检测**: 特定关键词组合会强制切换 task_type 为 edit
9. **并发保护**: tasks.json 和 images.json 的读写通过 Mutex 保护
10. **前端懒加载**: 所有页面组件使用 `React.lazy` + `Suspense`
