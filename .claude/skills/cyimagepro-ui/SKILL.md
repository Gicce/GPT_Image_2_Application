---
name: cyimagepro-ui
description: CyImagePro UI Design System（cyimagepro-ui）——本仓库所有前端 UI 开发的最高规范。新建/修改任何页面、弹窗、按钮、输入框、卡片、列表、状态标签、模型选择器、聊天气泡、任务卡之前必须先读本 Skill。覆盖：Design Token（颜色/字体/间距/圆角/控件高度）、公共组件（Button/Badge/Dialog/Toast/ModelPicker/BillingBadge）、页面布局（App Shell/Chat 工作台/表单页/数据页）、交互模式（模型选择/任务确认/错误重试/空状态）、中文文案规范（产品术语/状态词/计费文案）、UI Compliance Check。关键词：UI、Design System、Frontend、Button、Input、Form、Card、Dialog、Layout、Color、Typography、Spacing、Model Selector、模型选择器、计费、样式、界面、文案。
---

# CyImagePro UI System

```text
Skill ID:       cyimagepro-ui
Skill Version:  6.0.0
UI System Version: 1.2.0
Last Updated:   2026-08-24
Owner Code:     src/App.css（Token 定义唯一事实源）
                src/components/（公共组件）
```

## 0. 效力声明

CyImagePro 客户端（GPT_Image_2_Application）的所有前端 UI 开发必须遵循本 Skill。当旧页面实现与本 Skill 冲突时，以本 Skill 为准；旧代码渐进迁移（改到哪个组件，哪个组件治理），禁止一次性大爆炸重写。

## 1. Foundation（产品视觉语言）

CyImagePro 是 **深色优先的 AI 图像创作工作台**（Tauri 桌面软件），视觉关键词：

```text
Dark Workspace · Indigo/Violet 品牌主色 · 左侧主导航 · 对话式工作区 · Clean · Dense · Professional
```

禁止：把 CY Video Studio 的 Cyan/青绿主题复制进来；营销网站式渐变横幅；霓虹 Glow；巨型圆角；每个区域都有背景色；随机紫色/随机圆角/随机间距；大量 Emoji 装饰（既有 💬/⚡ 模式切换 emoji 属存量，不再新增）。

## 2. 分层规范索引

| 层 | 内容 | 文件 |
|---|---|---|
| 01 Foundation | 视觉语言/效力声明 | 本文件 |
| 02 Design Tokens | 颜色/字体/间距/圆角/控件高度 | tokens.md |
| 03 Components | 公共组件清单与使用规则 | components.md |
| 04 Layout | App Shell / Chat 工作台 / 表单页 / 数据页 | layouts.md |
| 05 Interaction Patterns | 模型选择/任务确认/错误重试/空状态/图片来源 provenance/图片库拖拽导入 等 | patterns.md |
| 06 中文文案规范 | 产品术语/状态词/计费文案/来源词 | copy.md |
| 07 Model Selector | 模型选择器专项规范 | model-selector.md |
| 08 Golden Samples | 现有优秀组件索引 + Compliance Check | examples.md |
| 09 Visual Workflow | 视觉理解复刻工作流（FinalPromptEditor / Diff / 维度锁定 / 评价） | visual-workflow.md |
| 10 Image Viewer | 内置图片查看器（遮罩关闭/视口滚轮缩放/锚点/平移/多图/复制/另存为） | image-viewer.md |

## 3. 开发工作流（强制）

```text
开发前：
1. 读本 SKILL.md → 按任务继续读 tokens / components / layouts / patterns / copy
2. 检索 src/components/ 现有组件 → 优先复用，禁止重复造
3. 颜色/间距/圆角/字号只从 Token 取值（var(--*)），禁止新写 hex / magic number

开发中（依赖方向，禁止倒挂）：
Token → Primitive Component → Business Component → Page
禁止：Page → 随手 CSS → 随手颜色 → 随手尺寸

开发后：
执行 examples.md 的 CyImagePro UI Compliance Check
（涉及业务代码时另跑：npm run typecheck && npm test && npm run build）
```

## 4. 最高优先级规则（违反即返工）

1. **颜色只来自 Token**：组件/页面禁止新写 `#hex` / `rgb()`（既有存量 rgba 徽章底色除外，见 tokens.md）。浅色/深色主题都必须可切换——新颜色必须同时落在 `[data-theme="light"]` 与 `[data-theme="dark"]` 的 App.css 变量里。
2. **品牌主色克制**：`--accent-primary`（Indigo #6366f1）只用于 当前选中 / Primary Action / Active 导航 / Focus 边框 / 发送按钮。禁止所有边框、所有按钮、所有文字都用主色。
3. **模型/计费 UI 走集中策略**：模型列表分组由 `modelUiPolicy.ts` 决定，计费文案由 `getBillingLabel` + `BillingBadge` 决定；禁止组件内按模型名称猜能力、禁止页面散落模型白名单、禁止现场拼接计费文案。详见 model-selector.md。
4. **按钮**：新代码优先复用 App.css 共享按钮类（`.app-btn-primary/secondary/danger` + `.app-btn-sm`）；图标按钮 32×32 必须带 `title`。
5. **表单**：Input/Select 用 `.form-group` 结构（Label → 控件 → Helper/Error），高度约 38px；错误不能只 Toast，关键表单要 inline error。
6. **Typography**：正文 ≥12px；Meta 10–12、正文 13–14、Card 标题 16、Modal 标题 18、页面标题 22。字重只用 400/500/600/700。
7. **间距/圆角**：只用 tokens.md 的 spacing scale 与 radius scale。
8. **中文文案**：产品术语/状态词/计费词必须来自 copy.md，禁止同义词漂移（「视觉理解」不得写成「图片理解/视觉分析」）。
9. **弹窗**：确认类用现有 Dialog 组件（DeleteConvDialog 等）；禁止页面内手写 overlay div 结构。
10. **渐进迁移**：新代码必须遵守；修改到的旧组件顺带治理；未涉及页面不做无意义大改。
11. **View State 与 Semantic State 分离（V4.1 铁律）**：Collapse / Expand / Tab / Viewer / Selection-only actions are view state. They MUST NOT change semantic revision or Prompt provenance. 折叠 / Tab / 查看类状态放专用 view store（如 `useVisionViewStore`），禁止塞进业务对象（RecreationPlan / Prompt Provenance / GenerationCarry）；需要「已修改待优化」类语义判定时一律用派生修订比较（semanticRevision !== optimizedRevision），禁止粘滞 dirty 标记。详见 visual-workflow.md §1e-1f。

## 5. 版本与升级

- 任何 Skill 修改必须记录 `CHANGELOG.md`；影响架构/流程的同步工作区根 `docs/`（02-FRONTEND / 08-CHANGELOG）并执行 RAGFlow 增量同步。
- Token 值变更 = UI System 版本号 +0.1；规则变更 = Skill 版本号 +1.0。
