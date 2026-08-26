---
name: cyimagepro-ui
description: CyImagePro UI Design System（cyimagepro-ui）——本仓库所有前端 UI 开发的最高规范。新建/修改任何页面、弹窗、按钮、输入框、卡片、列表、状态标签、模型选择器、聊天气泡、任务卡之前必须先读本 Skill。覆盖：Design Token（颜色/字体/间距/圆角/控件高度）、公共组件（Button/Badge/Dialog/Toast/ModelPicker/BillingBadge）、页面布局（App Shell/Chat 工作台/表单页/数据页）、交互模式（模型选择/任务确认/错误重试/空状态）、中文文案规范（产品术语/状态词/计费文案）、UI Compliance Check。关键词：UI、Design System、Frontend、Button、Input、Form、Card、Dialog、Layout、Color、Typography、Spacing、Model Selector、模型选择器、计费、样式、界面、文案。
---

# CyImagePro UI System

```text
Skill ID:       cyimagepro-ui
Skill Version:  16.0.0
UI System Version: 1.2.0
Last Updated:   2026-08-25
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
| 11 AI Model Routing | AI 模型路由（Model Role / Resolver / Follow / Fallback / 设置页「AI 模型使用」/ Provenance） | ai-model-routing.md |

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
12. **AI Model Routing（V4.1 铁律）**：No AI feature may silently inherit an unrelated global model（任何 AI 功能不得静默继承无关功能的全局默认模型）；Every AI model invocation must have an explicit model role；Displayed model MUST equal resolved runtime model（显示的模型 = 执行的模型，除非 UI 明确显示 fallback）。所有 AI 功能取模型一律走 `resolveModelForRole`（features/aiRouting），禁止组件内 `selectedModel || defaultModel`、禁止硬编码模型 fallback。详见 ai-model-routing.md。
13. **AI 结构化响应错误呈现（V4.0.9 铁律）**：Internal transport / parser / schema errors MUST NEVER be exposed directly in user-facing UI（serde / JSON / schema / invalid type 类细节只进开发日志）；Hiding an error message is NOT error recovery —— 必须先在数据层完成 normalize → validate → 最多一次结构修复，UI 层只做错误映射与技术信息拦截（视觉理解实例 `src/features/vision/visionErrors.ts`）；失败保留旧成功结果，失败后重试入口立即可用。详见 visual-workflow.md §0 与 patterns.md §8。
14. **Image Mention 与人物替换双图角色（V4.0.9 铁律）**：In Vision Workflow, @image mentions MUST resolve from current task/conversation images first（候选唯一来源 `buildVisionContextImages`，绝不串其它对话图片）；mention 必须绑定真实图片（assetId/path/role 侧车表），禁止纯文本补全 / 只把路径拼进 Prompt；Person Replacement is a first-class business action, not a weak advanced form section（业务卡 + 画面模板 / 替换人物双区）；When a task involves "replace the person in image A with the person from image B", the system must preserve the semantic roles of both images（A = template/style/composition reference，B = person replacement reference；面板显式选择 > 明确 Mention > 自然语言推断，绝不偷偷覆盖）。@ 输入必须是原生 textarea（IME 安全）。详见 visual-workflow.md §1c/§1g 与 patterns.md §19。
15. **三层 Provenance 与服装状态不变量（V4.0.9.1 铁律）**：User instruction, structured modification plan, and final execution prompt are three distinct provenance layers and MUST NOT be conflated（用户原话 / 修改方案 / 最终执行 Prompt 三层溯源严禁混淆；生成任务冻结 `GenerationProvenanceSnapshot`，历史「用户要求」只读快照，禁止用 final_prompt 伪造）。**clothingPolicy=preserve_original and clothing=modified is an invalid semantic state**（`clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'`，唯一归一入口 `normalizeModificationState`，UI 事件只调 domain action，禁止组件自行展开赋值）。详见 visual-workflow.md §1d/§1h。
16. **Creative Workflow MUST use Adaptive Workbench Layout（V4.1 Workbench V2 铁律）**：视觉理解等创作型工作流页面必须使用自适应工作台布局（`.vision-workbench` 双栏：主工作区 `minmax(0,1fr)` + Context Rail 340–390px，≥1600 宽 `min(100%,1520px)`；1440–1599 rail 320px；<1440 单列摘要卡）。禁止窄容器（旧 `max-width: 960px` 已删除，禁止回归）；设置类表单页仍走 Narrow Layout，两类页面禁止互抄。CTA（优化 / 确认生成）唯一渲染处 = Context Rail。
17. **Visual Project Pattern（V4.1 Workbench V2 铁律）**：视觉理解是项目化工作台（VisualProject：TemplateSnapshot 冻结基线 + ModificationContract overlay + Regions + RenderingContract + revision）。Template 是 baseline，用户修改绝不写回模板维度；项目语义修订（revision）只由语义事件驱动（updateActive / updateActiveDebounced 白名单 reason），折叠 / Tab / Viewer / hover 是视图操作绝不加修订；打开项目 = 本地恢复，绝不重新调用视觉分析 API；Effective Plan（`buildEffectiveVisualPlan`）是 Rail / 确认弹层 / Compiler / 溯源的唯一合成视图。详见 visual-workflow.md §7。
18. **Identity != RenderingMode（V4.1 铁律）**：人物参考决定「是谁」，Rendering Contract 决定「怎么画」。person reference 绝不自动决定媒介；overall style 修改（如赛博朋克）绝不改写任何媒介层 renderingMode（Style != Rendering Mode）；动漫对应角色 identityRelation=same_as_primary（= 主体人物的动漫化版本）；只有用户显式统一媒介（applyUniformRenderingMode）才允许改写。混合媒介模板必须保持分层。详见 visual-workflow.md §8。
19. **Region Editing Contract（V4.1 铁律）**：区域坐标一律归一化 0..1（禁止 CSS pixel 入状态）；mask 以文件路径引用（PNG 经 Rust 命令落盘），bitmap 绝不进 store；区域编辑器是全屏工作模式（禁止塞 Modal）；区域合同经项目语义通道写入（revision +1），展开区域卡 = 视图操作。详见 visual-workflow.md §9。
20. **Prompt Optimizer 无合同裁决权（V4.1 铁律）**：HARD CONTRACT values are immutable——人物是否替换 / 服装来源 / 区域是否应用 / 媒介结构 / 用户显式维度是用户已确认事实，优化器只负责表达（`buildOptimizerHardContractLines` → 优化请求【硬性合同】块；系统提示词规则 0），禁止推翻 / 省略 / 软化 / 重新决定。Prompt Compiler（`mergeFinalGenerationPrompt`）把全部合同层确定性编译进最终 Prompt。详见 visual-workflow.md §10。
21. **Task Failure UX（V4.1 铁律）**：Friendly error summary MUST be separated from technical diagnostics（友好摘要与技术诊断分层；raw error 只进「技术详情」折叠区且必须保留，绝不删除）；TaskQueue is operational status UI, History is full audit UI（任务队列只做状态 / 重试 / 时间，完整审计进历史记录详情，禁止第二套 Task Detail——深链 `openTaskDetailFromQueue`）；Terminal tasks MUST expose a terminal timestamp（终态任务必须显示真实结束时间，唯一入口 `resolveTaskFinishedAt`（completed_at），缺失显示「—」，禁止 Date.now() 伪值）；Native browser/system alerts MUST NOT be used for task retry feedback（重试反馈一律应用内 Toast）。主任务状态聚合唯一入口 `deriveTaskState(task)`（sub_tasks 事实派生六态，页面禁止自猜 task.status）；失败分类唯一入口 `classifyGenerationFailure`（canonical failure model：Rust 结构化 `error_detail` 优先、旧 string 回落解析；禁止各页面 substring 自分类）。详见 patterns.md §20 与 copy.md §13。

22. **Generation Quote & Pricing Transparency（V4.2 铁律）**：All paid image generation entries MUST obtain a server quote and show the QuoteConfirmDialog before authorize（所有付费生成入口提交前必须取服务端报价并弹确认层：单张/预计/余额/剩余）；Client MUST NEVER compute 数量×单价 by itself（报价与按钮价格标注一律来自服务端）；用户生成前 MUST 知道预计点数、生成后 MUST 看到实际点数、失败释放 MUST 在点数流水中可见；采购成本/毛利率/Provider 内部定价 MUST NOT 出现在普通用户界面。详见 patterns.md §21-§24。

23. **List State / Billing CTA / Canonical Reference（V4.2 铁律）**：Interactive list rows MUST preserve layout geometry across normal / confirm / loading states（列表行三区固定网格，确认态整体替换操作区，删除确认态唯一事实源 = 列表级单值状态；详见 patterns.md §25）；When the primary action is blocked by a recoverable account state, the remediation CTA belongs in the footer action hierarchy（余额不足时「去充值」进 footer 且为唯一 primary，确认生成 disabled，明细区补「还差 N 点」；详见 patterns.md §26）；The same source entity shown in multiple areas MUST share one canonical label / hover preview / viewer / status badge（同源实体跨区域统一 label/预览/徽标，锁定类摘要只在存在真实冻结合同时出现；详见 patterns.md §27）。
24. **Visual Consistency V5（角色与插图一致性铁律）**：Detail Group != Detail Instance（数量、绑定、Prompt、Trace 一律按真实画框实例；缺实例时用户触发受限补充识别，禁止打开项目自动调用 AI）；Prompt confirmation uses progressive disclosure（默认只显示来源/编辑/参考图/一致性/生成模型/尺寸数量/服务端预计点数，模型链路/任务 ID/路径/完整 Prompt 默认折叠）；System correction Toast uses user language and links to Skill Trace（禁止把 Guard/Contract/字段名暴露给普通用户）；Strict Visual Reference 使用紧凑「动漫角色参考」卡，缓存命中明确显示复用且零新增费用，重建必须再次报价确认。详见 patterns.md §28-§31。

## 5. 版本与升级

- 任何 Skill 修改必须记录 `CHANGELOG.md`；影响架构/流程的同步工作区根 `docs/`（02-FRONTEND / 08-CHANGELOG）并执行 RAGFlow 增量同步。
- Token 值变更 = UI System 版本号 +0.1；规则变更 = Skill 版本号 +1.0。
