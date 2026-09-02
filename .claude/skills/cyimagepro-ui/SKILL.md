---
name: cyimagepro-ui
description: CyImagePro UI Design System（cyimagepro-ui）——本仓库所有前端 UI 开发的最高规范。新建/修改任何页面、弹窗、按钮、输入框、卡片、列表、状态标签、模型选择器、聊天气泡、任务卡之前必须先读本 Skill。覆盖：Design Token（颜色/字体/间距/圆角/控件高度）、公共组件（Button/Badge/Dialog/Toast/ModelPicker/BillingBadge）、页面布局（App Shell/Chat 工作台/表单页/数据页）、交互模式（模型选择/任务确认/错误重试/空状态）、中文文案规范（产品术语/状态词/计费文案）、UI Compliance Check。关键词：UI、Design System、Frontend、Button、Input、Form、Card、Dialog、Layout、Color、Typography、Spacing、Model Selector、模型选择器、计费、样式、界面、文案。
---

# CyImagePro UI System

```text
Skill ID:       cyimagepro-ui
Skill Version:  23.1.0
UI System Version: 1.3.0
Last Updated:   2026-09-02
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

25. **Recoverable Blocker Pattern（V6.1 铁律）**：A blocking validation that the system itself can repair MUST ship with an in-place Repair CTA（凡系统内具备修复能力的阻断校验，必须在阻断卡原位提供修复主按钮；禁止「请去某处处理」的无入口死路）。Repair is scoped, never a rewrite（受限修复：只补缺失字段及其直接依赖，`updateActive` 语义修订，禁止整写模板/覆盖用户修改/丢失 originSkill 与冻结快照）；Repair states are explicit（进行中说明「不会改变什么」、失败保留旧分析 + 重试 + 技术详情默认折叠、成功绿色状态 + 阻断自动消失）；错误文案事实源唯一（Validator 与 Rail 共用同一纯函数，如 `detailInsertIncompleteErrors`，禁止两套文案）。详见 patterns.md §32。

26. **Nested Modal / Picker Pattern（V6.1 铁律）**：Any secondary modal/picker opened from inside a modal MUST portal to `document.body` with its own overlay and stacking context（二级弹窗必须 `createPortal(document.body)` + 自包含样式 + 独立 fixed overlay；禁止 render 在父 modal DOM 内继承父列宽，禁止依赖其它懒加载页面的 CSS chunk——chunk 缺失会把弹窗压成内容宽）；Escape closes only the topmost layer（父弹窗用 `galleryOpenRef` 守卫，二级弹窗自己的 keydown 关自己）；底层弹窗在二级打开期间锁定正文滚动（`.is-picker-open .xxx-body { overflow: hidden }`）；层级纪律：业务弹窗 1200 < 二级选择/确认层 1300 < ImageViewer 4000。详见 patterns.md §33。

27. **Wizard Geometry Pattern（V6.1 铁律）**：Multi-step creators MUST keep Header / Body / Footer geometry stable across steps（多步骤创作器三段式：固定 Header + 固定 Footer，弹窗宽高只随视口 `min(Npx, calc(100vw/vh - 48px))`，步骤差异一律由 Body 内部滚动消化 `overflow-y:auto + min-height:0`；禁止步骤切换改变弹窗几何类）；长详情默认折叠（Recipe/合同块默认摘要 + 【查看完整】toggle，`aria-expanded`）；窄宽度退化有明确断点（≤860px 步骤栏转顶部水平 stepper）；稀疏步骤用 content stack 居中收拢，禁止拉大控件填满。详见 patterns.md §34。

28. **Destructive CRUD Pattern（V6.1 铁律）**：Every create/edit surface MUST audit its delete closure（有创建就必须有删除闭环：stable ID、二次确认 danger 弹窗、原子状态清理、持久层真实删除 + 回归测试；禁止只做 UI 隐藏）；Delete scope must be explicit in copy（确认文案列明删什么、不删什么；Submitted 类实体默认只删本地，服务器记录/源图/历史项目不受影响，文案由纯函数事实源提供如 `describeSkillDeleteNotice`）；Deleting the currently-open entity MUST close its editing state（`selectedId` 同步清理）；成功 Toast 用「已删除「名称」」句式 + 空态 CTA 引导创建。详见 patterns.md §35。

29. **Product Maturity V6.2 五铁律**：① **Progress Honesty**——长耗时 AI 任务进度只含真实事实（阶段 / 真实计数 / 已用时），进度对象禁止 percent 字段，UI 用 indeterminate + 每秒计时，取消 = 层间诚实停止（patterns.md §36）；② **Direct Execution**——复用型能力提供「快速生成 / 高级调整」双路径，headless 快速路径与工作台同一套引擎、零 AI 调用、ephemeral 不落库，autoStart 绝不绕过报价确认（patterns.md §37）；③ **Semantic Reference Label**——参考图角色徽标唯一事实源 `SEMANTIC_REFERENCE_LABELS`，计划图角色冻结（无 inline dropdown）、手动图 ⋯ 菜单，禁止「参考图N」裸序号命名（patterns.md §38）；④ **Auto Save State**——动态工作区语义自动保存四态指示，「已保存」判定必须无待存编辑、失败保 dirty 可重试、切项目先冲刷在途（patterns.md §39）；⑤ **Handoff Responsiveness**——确认交接在同步守卫后 100ms 级关弹窗切过渡态，重活后移 + 预热并行 + 防重入 + operationId Toast 去重（patterns.md §40）。

30. **Direct UX Closure V6.3 五铁律**：① **Semantic Feedback Severity**——系统自动修正 Toast 的严重级按「最终用户状态」判定：系统已替用户修正成功 ⇒ 绿色 success；只有当被剥离内容确实来自用户当前文字指令时才 orange warning（唯一判定入口 `contractCorrectionSeverity` / `lockCorrectionSeverity`，禁止组件自猜）（patterns.md §41）；② **Direct Preflight Status**——快速生成前置检查用四态状态卡（READY 绿「可以快速生成」/ REPAIRABLE 橙「还差 1 步 + 立即处理」/ NEEDS_USER_DECISION 业务输入非错误 / BLOCKED 需工作台），分类唯一入口 `classifySkillDirectPreflight`，禁止弱化成一行小字（patterns.md §42）；③ **Modification Slot Fidelity**——Skill 输入槽位由 ModificationContract 派生（`deriveSkillInputSlots`），身份+服装来自同一人物参考 ⇒ 一个 combined 槽，自定义服装 ⇒ 文本槽；换槽位绑定 = 重绑 facts + 确定性重编译，丢弃实例专属优化 delta，绝不触发「重新优化 Prompt」建议（patterns.md §43）；④ **Compact Subject Replacement**——人物替换面板四分组（主体 / 来源 / 执行范围 / 替换强度），映射卡缩略图 120–160px 横排，点击进全局 ImageViewer，动作叫「更换人物参考」（patterns.md §44）；⑤ **Entity Cover**——实体封面（Skill Cover）是 display-only 元数据：优先级 自定义 ＞ 公开样例 ＞ 模板图 ＞ 图标；选择器复用唯一 `ImageLibraryPicker`，封面绝不进入投稿载荷、删除实体绝不删除图库文件（patterns.md §45）。

## 5. 版本与升级

- 任何 Skill 修改必须记录 `CHANGELOG.md`；影响架构/流程的同步工作区根 `docs/`（02-FRONTEND / 08-CHANGELOG）并执行 RAGFlow 增量同步。
- Token 值变更 = UI System 版本号 +0.1；规则变更 = Skill 版本号 +1.0。

31. **Gallery Folders & Staged Modification（V6.6 四铁律）**：① **Physical Folder Binding**——图库文件夹 = 物理目录 + `image_folders` 注册表（ADR-029）：新建真实建目录（默认 `default_output_dir`，空回落系统图片目录），图片归属按 `local_path` 归一化前缀判定（`matchesGalleryFolder`），**禁止**给 ImageRecord 加 folder_id 或造虚拟分组；删除文件夹只删注册行，**绝不删磁盘文件**；② **Single Output Path Picker**——生成入口的输出位置收敛为全库唯一 `components/OutputPathPicker.tsx`（默认路径 / 图库文件夹下拉 / 浏览 / 自定义兜底显示），未选文件夹 = `default_output_dir` 预填（「默认路径下生成」），禁止页面各自再造 readOnly+浏览 组合；③ **Staged Modification（V6.7 四步向导）**——视觉理解主流程 = 左侧步骤栏（1 视图理解 / 2 需求描述 / 3 素材替换 / 4 最终提示词）+ 当前步骤内容 + 右侧 ContextRail（项目进度 checklist + 替换情况 + 技能执行）；门禁与自动前进由 `visionWizard.ts` 纯函数判定（第 3 步必须先在第 2 步描述；优化成功自动 2→3 / 3→4），`useVisionViewStore.wizardStep` 纯视图写可随时回退，**禁止**步骤切换触碰 modificationDraft / semanticRevision；④ **Enabled-Card Consistency**——同层级「已启用」业务卡必须同一强调边框（accent border + light 光晕）：`.vision-person-panel.is-business` / `.vision-clothing-panel` / `.vision-dimension-edit-panel` 三卡统一，禁止单卡独享高亮造成「只有某张卡是紫框」的错觉（patterns.md §46）。

32. **Workflow Step Status & Material Confirm（V6.8 四铁律）**：① **Unified Step Selector**——多步工作流的步骤完成态只有一个 selector（`getVisualWorkflowState(ctx)`：步骤 × pending/current/completed 三态，`currentStep` = 第一个未完成步骤），步骤栏 / Rail 进度卡 / 完成徽标一律查表，**禁止** UI 从零散字段（editState / revision / 面板折叠态）各自反推完成（V6.7 前 `visionStepDone(3) = editState === 'optimized'` 即被本条取代的根因做法）；② **Material Replacement completes only by explicit confirm**——「整理素材」类步骤的完成 = 用户点击确认按钮持久化的显式位（`workspace.materialReplacementDone`；走 `updateActiveMeta` / workspace 快照字段，不加修订不触发待优化），旧数据缺省 **false 保守恢复**（「曾优化过 / 已有素材配置 / 没改素材」≠「已完成」，绝不删除旧项目数据只做缺省归一），素材域语义修改（reason ≠ generation_result）自动复位确认位；③ **Source Menu Anchored Below Card**——卡片内的来源菜单（图片库 / 本地导入 / 文字描述）锚定在**卡片下方整列宽**（`.vision-person-map-source-row`），绝不参与卡内宽度计算、不挤压信息区；边框 / 圆角 / 底色 / 内边距归卡根所有，卡内节点一律无边框（**禁止负 margin / 定宽补丁**）；④ **Stage-Anchored Progress**——长耗时单次 AI 调用的进度百分比只能来自阶段锚点派生（`deriveOptimizationPercent`；服务层 `onStage` 在真实边界触发 collecting → optimizing → validating），进度对象只存 status/startedAt/errorText 事实（**禁止** `setInterval(() => percent += …)` 与随机推进），失败态不渲染进度条、只显示真实错误 + 重试入口。详见 visual-workflow.md §11 与 patterns.md §36/§46。

33. **Effective Intent Optimization Input & Save-as-Skill CTA（V6.8.1 三铁律，ADR-030）**：① **Single Instruction Builder**——「优化 / 重建最终 Prompt」这类把用户全部设置交给 AI 的入口，指令只能来自唯一组装器（视觉复刻 = `recreationOptimizationInput.ts#buildRecreationOptimizationInstruction(draft, project, context)`：需求描述合同 + 区域替换逐项块 + 人物替换合同 V2 行），**禁止**组件自拼 Prompt 字符串、**禁止**把 workspace/project 整体 JSON 丢给模型；新增能力一律扩展组装器，让「优化输入、过期触发、payload 测试」三处同时生效；② **Effective State Only**——组装器只读当前生效态：存储残留（如服装来源切到「人物服装」后遗留的旧 customClothing 文本）在读取边界清洗（`getEffectiveModificationDraft`，存储层保留以便切回）、停用区域（enabled=false）与解析不到的绑定绝不虚构进入；**所有会改变生效意图的输入**（需求描述 / 维度 / 服装三态 / 区域增删改 / 人物合同 / 参考绑定）必须经统一指令变化 → semanticRevision → needsOptimization（视觉页三条项目侧入口接 `syncRecreationInstructionFromProject`），优化完成后 CTA / 技能保存可用态 / 方案卡同步刷新，绝不保存过期 Prompt；③ **Secondary Actions Never Compete with Primary**——CTA 区的 Primary（高强调）按钮每区**至多一个**；「复刻成我的技能」等衍生动作以 `vision-btn`（无高强调 class）落位 Rail CTA 区、排在 Primary 之前，可用判定 = 业务条件派生（有项目 + 最终 Prompt 未过期 + 非进行中），disabled 时 title 说明原因——**禁止**为恢复丢失入口而新写一套保存实现，必须复用现存原链路（`saveRecreationAsSkill → SkillCreatorDialog`）。视觉页分区纵向间距用标准档 token（`margin-bottom: 24px`，见 tokens.md §3），禁止 magic margin。详见 visual-workflow.md §12。
