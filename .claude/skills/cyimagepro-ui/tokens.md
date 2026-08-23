# Design Tokens（CyImagePro）

> 唯一事实源：`src/App.css` 的 `[data-theme="light"]` / `[data-theme="dark"]` 变量块。
> 本文件是「语义 → 变量名」的映射规范。所有新 UI 只允许引用 `var(--*)`，禁止新写 hex。

## 1. Color

### Surface（表面）

| 语义 | 变量 | 说明 |
|---|---|---|
| surface.body | `--bg-body` | 应用最底层（light #f5f5f5 / dark #1a1a1a） |
| surface.page | `--bg-page` | 主内容区底（light #fafafa / dark #212121） |
| surface.card | `--bg-card` | 卡片（light #fff / dark #2a2a2a） |
| surface.cardAlt | `--bg-card-alt` | 卡片内分区 |
| surface.section | `--bg-section` | 卡片内嵌面板（light #f8f9fa / dark #242424，dark 为下沉式）：设置面板 / Segmented 轨道 / StatCard / 上传区 / AI 结果面板 |
| card shadow | `--card-shadow` | 卡片浮起阴影（light 双层微影 / dark `none`，靠 border 区分层级） |
| surface.elevated | `--bg-dialog` | 弹窗 / 浮层（light #fff / dark #2a2a2a） |
| surface.input | `--bg-input` | 输入控件底（dark #2f2f2f） |
| surface.hover | `--bg-hover` | 通用 hover（dark #484848） |
| surface.subtle | `--bg-subtle` | 次级面板底 |
| surface.inset | `--bg-inset` | 内嵌区域（dark #1e1e1e） |
| surface.sidebar | `--bg-sidebar` | 主导航（light #1a1a2e 恒深 / dark #171717） |
| surface.chat | `--bg-chat` / `--bg-chat-hover` / `--bg-chat-input` / `--bg-chat-sidebar` | 聊天工作台专用 |
| surface.overlay | `--bg-overlay` | 模态遮罩（rgba(0,0,0,0.55~0.6)） |
| surface.error | `--bg-error` | 错误横幅底 |

### Border（边框）

| 语义 | 变量 |
|---|---|
| border.default | `--border-default`（light #e5e7eb / dark #4a4a4a） |
| border.subtle | `--border-subtle`（比 default 深一档，hover 强化用） |
| border.light | `--border-light`（最浅分隔线 / Badge 描边，dark #2e2e2e） |
| border.input | `--border-input`（输入控件描边） |
| border.chat | `--border-chat` |
| border.sidebar | `--border-sidebar` |
| border.focus | `--accent-primary`（focus 直接用主色描边） |

### Text（文字）

| 语义 | 变量 |
|---|---|
| text.primary | `--text-primary`（标题/强调，dark #ececec） |
| text.secondary | `--text-secondary`（正文，dark #d1d5db） |
| text.tertiary | `--text-tertiary` |
| text.muted | `--text-muted`（辅助说明，dark #9ca3af） |
| text.faint / placeholder | `--text-faint` / `--text-placeholder` |
| text.heading | `--text-heading` |
| text.chat / chat-muted | `--text-chat` / `--text-chat-muted` |
| text.sidebar.* | `--text-sidebar` / `-title` / `-subtitle` / `-hover` / `-active`（active #a5b4fc 淡靛蓝） |
| text.onAccent | `--text-on-accent`（主色按钮上的白字） |
| text.link | `--text-link` / `--text-link-hover` |
| text.error | `--text-error` |

### Brand（品牌）

| 语义 | 变量 | 值 |
|---|---|---|
| brand.primary | `--accent-primary` | `#6366f1`（Indigo，两主题一致） |
| brand.primaryHover | `--accent-primary-hover` | `#4f46e5` |
| brand.soft | `--accent-primary-light` | light #eef2ff / dark rgba(99,102,241,0.25) |
| brand.text | `--accent-primary-text` | light #4f46e5 / dark #a5b4fc |

> 品牌色是 Indigo/Violet 系。禁止引入 Studio 的 Cyan，禁止新增随机紫色 hex。

**Brand 强度三档（V4.0.8 图片生成页验证）**：

| 档位 | Token 组合 | 用途 |
|---|---|---|
| Strong | `--accent-primary` 实底 + `--text-on-accent` | Primary CTA（每页最多 1 个） |
| Medium | `--accent-primary-text` 文字色（可配 `--accent-primary-light` 底） | Segmented 选中文字、摘要强调值、StatCard 最终数字 |
| Soft | `--accent-primary-light` 底 + `--border-prompt` 描边 | AI 次级 CTA（如「AI 智能规划并优化 N 个方案」）、已采用 Badge |

禁止把 Strong 档用在模式选择、步骤编号、普通数字信息上。

### Status / Badge

| 语义 | 变量 |
|---|---|
| status.success | `--accent-success`（#059669 / #10b981）+ hover `--accent-success-hover` |
| status.danger | `--accent-danger`（#dc2626 / #ef4444） |
| status.warning | Badge 系 `--badge-warn-bg` / `--badge-warn-text`（含存量 rgba 琥珀） |
| status.info | `--badge-info-bg` / `--badge-info-text` |
| badge.success / danger / muted | `--badge-success-*` / `--badge-danger-*` / `--badge-muted-*` |
| diff.added（V4.1） | `--diff-added` / `--diff-added-bg`（success 语义派生，light/dark 双主题） |
| diff.removed（V4.1） | `--diff-removed` / `--diff-removed-bg`（danger 语义派生，light/dark 双主题） |
| 滚动条 | `--scrollbar-thumb` / `--scrollbar-thumb-hover` |
| 代码块 | `--bg-code-block` / `--bg-code-header` / `--border-code` |
| 提示词块 | `--bg-prompt` / `--border-prompt` / `--text-prompt-*` |
| 思考过程 | `--bg-reasoning` / `--border-reasoning` / `--text-reasoning` |
| Token 角标 | `--bg-token-badge` / `--text-token-badge` |

## 2. Typography

字体栈：`'Segoe UI Variable', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif`；代码：`'Cascadia Code', 'Fira Code', Consolas, monospace`。

| 层级 | 字号/字重 | 现有实现 |
|---|---|---|
| 页面标题 | 22px / 600 | `.page-header h2` |
| 弹窗标题 | 18px / 600 | Dialog h3 |
| 卡片标题 | 16px / 600 | 各业务卡 |
| 强调正文 | 14px / 400–600 | 输入框、重要说明 |
| 正文 | 13px / 400 | 按钮、表单 label（500）、选项行 |
| 次要说明 | 12px | hint、分页、小按钮 |
| Meta / Badge | 10–11px | BillingBadge 10px、模型 Tag 11px |
| 空状态主文案 | 16px | `.empty-state p` |
| 行高 | 正文 1.5–1.6，聊天气泡 1.7 | 存量 |

禁止：<10px 文字；新造 font-size 值；中文字重超出 400/500/600/700。

## 3. Spacing Scale

从存量归纳的允许值（px）：

```text
4 · 8 · 12 · 16 · 24 · 32      （标准档）
6 · 18 · 28                     （紧凑/过渡档，仅限既有场景延续）
```

页面容器 padding：`28px 32px`（`.page`）。禁止 `margin-left: 17px` / `padding: 13px 19px` / `gap: 11px` 这类无依据 magic number。

## 4. Radius Scale

| 语义 | 值 | 用途 |
|---|---|---|
| radius.tag | 4px | 小 Tag（模型状态角标） |
| radius.option | 6px | 下拉选项行、错误横幅按钮 |
| radius.control | 8px | 标准按钮 / 输入框 / Dialog 内按钮（`.app-btn` 全系） |
| radius.panel | 10px | Dropdown / 浮层面板 |
| radius.card | 12px | 加载卡等中等浮层 |
| radius.pill | 14px | 胶囊按钮（ModelPicker 触发器）；999px 用于全圆角 pill |
| radius.round | 50% | 圆形按钮（回到底部） |

## 5. Control Height（控件高度）

| 控件 | 高度 | 出处 |
|---|---|---|
| 图标按钮（Composer 工具条） | 32×32 | `.chat-input-btn` |
| 发送按钮 | 38px | `.chat-btn-send` |
| 会话列表行 | ≥44px（虚拟化按 46px） | `.chat-conv-item` / CONVERSATION_ROW_HEIGHT |
| 标准按钮 | ~37px（10px 16px padding） | `.app-btn` 系 |
| 小按钮 | ~30px（7px 12px padding） | `.app-btn-sm` |
| 表单输入 | ~38px（9px 12px padding） | `.form-group input` |
| 模型选项行 | ~34px（8px 12px padding） | `.model-option` |
| Composer 输入区 | min 24px → max 200px 自适应 | `.chat-input-box textarea` |
| Dropdown 面板 | max-height 380px 内部滚动 | `.model-picker-panel` |
