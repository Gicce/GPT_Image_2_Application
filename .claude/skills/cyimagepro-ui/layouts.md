# Layouts（CyImagePro 页面布局规范）

> 数值全部提取自现有代码。新页面不得重新定义侧栏宽度 / 头部高度 / 滚动归属。

## 1. App Shell（三层）

```text
┌──────────┬─────────────────────────────┐
│ Sidebar  │  Main Wrapper               │
│ 220px    │  ├ Header（页面级，按页自定义）│
│ 恒深色    │  └ Main Content（滚动归属）  │
└──────────┴─────────────────────────────┘
```

| 结构 | 数值 / 行为 | 出处 |
|---|---|---|
| 主导航 Sidebar | `width: 220px; min-width: 220px`，Logo 区 64px，恒深色（`--bg-sidebar`） | `components/Sidebar.css` |
| Main Content | `flex:1; overflow-y: auto; background: var(--bg-page)`；聊天页 `overflow:hidden`（滚动下放给 chat-area） | `App.css` |
| 页面容器 `.page` | padding `28px 32px`，`min-width: 0` | `App.css` |

## 2. 页面宽度策略（V3.0.6 起）

| 页面类型 | max-width | 例子 |
|---|---|---|
| 数据密集页 | 铺满（无 max-width） | 图库 Gallery / 任务队列 TaskQueue / 历史记录 History |
| 表单型页面 | 自定可读宽度 | Settings 1280 / ImageStudio 1480 / Account 1400 |

## 3. AI 智能体工作台（Chat，三层嵌套）

```text
App Navigation（220px）
    ↓
chat-page（flex，height:100%）
  ├ chat-sidebar 240px（可折叠至 0；「+ 新对话」按钮 + 会话列表）
  └ chat-main（flex:1; min-width:0）
      ├ chat-header（模型标识 + BillingBadge + 复制按钮 + ContextMeter）
      ├ chat-area（唯一滚动容器；内容宽 min(100%, clamp(780px, 48vw, 1180px))）
      └ chat-input-area（Composer，宽度同内容区）
```

| 结构 | 数值 | 出处 |
|---|---|---|
| 会话侧栏 | `width: 240px; min-width: 240px`；折叠 `width:0`；≤1080px 媒体查询自动收窄 | `pages/Chat.css` |
| 内容最大宽 | `--chat-content-max-width: min(100%, clamp(780px, 48vw, 1180px))` | Chat.css 变量 |
| 会话行高 | 44px min / 虚拟化 46px | Chat.css + Chat.tsx |
| Composer 结构 | topbar（💬 对话 / ⚡ 任务 切换）→ 图片上下文栏 → 输入框（24→200px 自适应）→ 工具条（32×32）+ 发送（38px）→ disclaimer 行（ModelPicker + 免责声明） | Chat.tsx |
| 滚动归属 | chat-area 内滚；侧栏列表内滚（虚拟化）；页面本体不滚 | Chat.css |
| 回到底部按钮 | 绝对定位 36×36 圆钮，bottom 随 Composer 实测高度偏移 | Chat.tsx |

聊天内容统一宽度（气泡、输入区同轴）：新元素加入聊天流时必须套同一 `--chat-content-max-width`，禁止自成宽度。

## 4. Creator Workspace（图片生成页 Golden Sample，V4.0.8）

```text
.page.image-studio-page（max-width 1600，flex column gap 20）
  .page-header（h2 22px + 13px 说明）
  .studio-mode-bar（两组 .studio-seg Segmented + 右侧 AI 辅助胶囊）
  .studio-workspace（grid：minmax(0,1fr) + var(--studio-sidebar-width)=320px；≤1200px 切单列）
    .studio-main → .settings-card.studio-card（Surface: bg-card + card-shadow + border-default）
      Section（.studio-section-head[.divided]：15px/600 标题 + 12px hint）
      .studio-settings 面板（surface.section：尺寸/质量/格式 grid + 输出目录行）
    .studio-sidebar（单卡片容器：sticky top 20 + max-height calc(100vh-48px) + 内部滚动）
      .studio-side-section 任务摘要/生成摘要（键值行 + .studio-cta-btn Primary CTA）
      .studio-side-divider
      .studio-side-section.studio-recent 最近任务（列表 max-height 340 内滚）
```

规则（已由 `src/pages/__tests__/imageStudioUi.test.ts` 契约锁定）：

- 单页表单不做人造步骤编号（禁止 1/3/4 式 Wizard 暗示）。
- 单张/批量共用 `GenerationSettings`（尺寸/质量/格式/目录唯一实现）与同一 Primary CTA 样式。
- TaskSidebar 是一个卡片容器（摘要 + 最近任务同卡、同 padding/半径/标题位），不是漂浮盒子。
- 页面级限宽 ≤1600px 且 >1200px；主列 `minmax(0, 1fr)` 可压缩、侧栏固定 320px 不压缩。

## 5. 表单页模板（Settings / ImageStudio / Account）

```text
.page（表单页类名 + max-width）
  .page-header（h2 22px + p 13px 说明）
  卡片分区（--bg-card + radius + border-light）
    .form-group × N
    操作行（右对齐：次按钮 + 主按钮）
```

## 6. 数据页模板（Gallery / TaskQueue / History）

```text
.page（铺满）
  .page-header + 过滤/操作条（TaskFilterBar）
  网格（Gallery auto-fill）/ 表格 / 列表
  .empty-state（居中 80px 上下 padding，16px 主文案 + 13px hint）
  .load-more / 分页
```

## 7. 弹窗模板

```text
overlay（--bg-overlay，点击关闭）
  modal 卡片（--bg-dialog，radius 10-12，最大高度限制 + 内部滚动）
    header（标题 18px + 关闭 ×）
    body
    footer（取消 / 主操作；主操作 .app-btn-primary）
```

## 8. 响应式检查基准

窗口宽度 `1280 / 1440 / 1920 / 2560` 下必须：无重叠、无横向滚动、无关键状态截断（尤其 Badge 不换行）、Dropdown 不越界。
