# cyimagepro-ui CHANGELOG

## Skill 6.0.0 / UI System 1.2.0（2026-08-24，V4.1 图库来源收口：Source / AssetType 分离）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **patterns.md**：§17 Image Source Provenance 升级为强制规则——**All user-visible source labels MUST resolve through `resolveImageSource()`**；**Gallery Card / Filter / Detail / Viewer source labels MUST never diverge**；来源（Source）与用途（AssetType）分离（禁止默认「类型：生成结果」与「类型 / 来源类型 / 生成类型 / 资产来源 / 图片来源」label）；外部源路径 ≠ 资产来源（禁止 WeChat / QQ 路径关键词细分）；补 Rust classify 平局规则（本地目录 = 输出目录时归 library_input）。
- **copy.md**：§9 来源表更新（video_pose 详情拆 来源=CY Video Studio / 用途=动作白膜；外部拖入一律本地）；新增 **§9a 详情字段名表**（文件名 / 来源 / 用途 / 导入时间 / 生成时间 / 尺寸 / 格式 / 文件大小 / 生成模型 / 任务 ID / 动作白膜批次键）。
- **components.md**：新增 `resolveImageDetailMetadata`（features/gallery/imageDetailMetadata.ts）条目——详情 / Viewer metadata 唯一 view-model resolver，内部复用 resolveImageSource。
- SKILL.md：版本 5.0.0 → 6.0.0（规则变更）。

配套代码（V4.1 图库详情来源收口）：

- 根因修复（Rust `commands.rs`）：`classify_source_kind` 目录平局（library_input_dir == default_output_dir，用户实机配置）从「output 胜」改为「library_input 胜」——拖入图片不再被标 output 而显示「生成结果」；chat / transparent 子目录判定前置（不受嵌套影响）；`sync_images` 为发现文件落 `file_size`；ImageRecord（models.rs）新增 `file_size`（serde default，全产出链路写入）。
- `src/features/gallery/imageDetailMetadata.ts`（新）：详情唯一 view-model resolver——基础信息行（来源 / 用途 / 导入时间·生成时间 / 尺寸 / 格式 / 文件大小 / 生成模型 / 任务 ID）+ 动作白膜批次区 + viewerMetadata。
- `Gallery.tsx`：详情 Modal 删除第二套「类型 / 执行模型 / 创建时间」拼装，改消费 resolver；Viewer metadata 同源；pose 区标题「来源」→「动作白膜」（来源 / 用途移入基础信息，不再两套解释）。
- `PersonReplacementPanel.tsx` / `VisionResultSection.tsx`：Viewer metadata label「类型」→「用途」。
- 测试：新增 imageDetailMetadata 契约（微信拖入 / Card·Detail·Filter·Viewer 一致性 / linked-task 不误标本地 / CY Video 拆分 / 字段真实性 / 旧数据兼容）；gallerySourceProvenance 守卫升级（禁「类型」label 全项目扫描）；cargo 新增同目录 classify + 微信临时目录导入回归。

## Skill 5.0.0 / UI System 1.2.0（2026-08-24，V4.1 图片库拖拽导入：Gallery File Drop Pattern）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **patterns.md**：新增 **§18 Gallery File Drop Pattern**——OS File Drop on Gallery → explicit local import；拖拽导入必须复用唯一入库 Pipeline（Rust `import_images_to_library` → `sync_images`，与手动放入目录同链路）；Local is explicit provenance, never a generic fallback；Active Modal > Gallery File Drop；Overlay 只覆盖图库主内容区；重名策略只存在于导入命令内（页面 / 前端禁止自拼 ` (1)` 后缀）；导入刷新只接受 Rust 返回的全量列表（不 push 数组头、不改当前筛选）。
- **components.md**：新增 GalleryDropOverlay（纯 UI）/ useGalleryFileDrop（事件翻译 + api/Toast 注入）/ galleryFileDrop controller（状态机 + 文案唯一来源）三个条目；useImageStore 增 applyImages。
- **copy.md**：新增 §11 图片库拖拽导入文案表（Overlay / Toast / 失败原因全套固定词，禁止组件随手拼）。
- **image-viewer.md**：§1 渐进迁移更新——Gallery 详情 Modal 大图点击已接入全局 ImageViewer（V4.1）。
- SKILL.md：版本 4.0.0 → 5.0.0（规则变更），索引 05 描述补图片库拖拽导入。

配套代码（V4.1 Gallery Drag Import）：

- Rust `commands.rs`：新增 `import_images_to_library` 命令——外部文件复制进 `library_input_dir`（mtime 刷新为导入时间 → 「最新优先」排最前）；已在管理目录 / 同名同内容（md5）→ 跳过不复制；重名不同内容 → `girl (1).png` 后缀；单文件失败不中断整批；索引建立完全复用 `sync_images`（+7 单测：复制 / 跳过 / 碰撞 / 非法 / 去重 / 未配置目录）。
- `src/features/gallery/galleryFileDrop.ts`（新）：拖拽状态机（enter/over/leave/drop + processing 防重入）+ `galleryDropOverlayCopy` / `describeImportResult` 文案唯一来源。
- `src/hooks/useGalleryFileDrop.ts`（新）：Tauri `onDragDropEvent` → controller；enabled=false（详情 Modal / 全局 ImageViewer 打开）时不监听并复位；Toast（正在导入 N 张…→ 已导入 N 张 / N 张失败 + 失败明细）。
- `src/components/GalleryDropOverlay.tsx` + `.css`（新）：纯 UI Overlay（Brand Indigo 虚线框 + Brand Soft 底 + 图标 + fade/scale 0.12s + reduced-motion 降级 + role=status；全部语义 Token，双主题）。
- `Gallery.tsx`：接入拖拽（enabled: !preview && !viewerOpen）；详情 Modal 大图点击 → `openViewer`（渐进迁移）。
- `useImageStore`：新增 applyImages（Rust 返回全量列表直接刷新）。
- 测试：vitest 795（新增 galleryFileDrop 20 / galleryDropImport 守卫 7）；tsc + build 全绿；cargo 183。

## Skill 4.0.0 / UI System 1.2.0（2026-08-23，V4.1 视觉理解修改流程收口：结构化修改意图 / 语义修订模型）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **SKILL.md**：最高优先级规则新增 **#11 View State 与 Semantic State 分离铁律**——Collapse / Expand / Tab / Viewer / Selection-only actions are view state. They MUST NOT change semantic revision or Prompt provenance. 版本 3.0.0 → 4.0.0（规则变更）。
- **visual-workflow.md**：新增 §1a Visual Analysis Loading Pattern（真实 analyzing 阶段 + 确定性文案轮播 + reduced-motion + 失败即停）、§1b Modification Dimension Selector（结构化 toggle / 唯一槽位 / 提高复刻度独立开关 / Brand Soft 选中态）、§1c Person Replacement Pattern（三来源 tab / 移除链 / ImageViewer / carry 第二参考）、§1d Clothing Policy（三策略单选 / clothing 独立第九维 / 显式保留替换约束）、§1e View State vs Semantic State、§1f Semantic Revision（semanticRevision/optimizedRevision 派生 needsOptimization）；§3 补合成指令与九维 changed_dimensions；§4 补服装锁定不伪造 diff。
- **patterns.md**：§15 首条铁律「UI-only interaction MUST NOT dirty semantic state」；§13.2 快捷 Chip 从「追加文本」改为「结构化维度选择器」。
- **components.md**：新增 VisualAnalysisProgress / ModificationChips / PersonReplacementPanel / useVisionViewStore / modificationIntent.ts 五个真实落地条目。
- **copy.md**：新增 §8a 修改维度 / 人物替换 / 服装处理 / 分析阶段文案表（含 ANALYSIS_PROGRESS 文案池单一来源约定）。

配套代码（V4.1 视觉修改流程）：

- `src/features/vision/modificationIntent.ts`（新）：ModificationDraft 结构化意图（freeText + activeDimensions 唯一槽位 + person + clothingPolicy + replicationBoost）、buildModificationInstruction 合成指令、持久化迁移。
- `src/store/useVisionViewStore.ts`（新）：视觉页 View State 唯一载体（不持久化）。
- `src/features/vision/VisualAnalysisProgress.tsx`、`ModificationChips.tsx`、`PersonReplacementPanel.tsx`（新组件）。
- `recreationPlan.ts`：RecreationFieldKey 增 clothing（九维）；`modified` 粘滞标记 → `semanticRevision/optimizedRevision`；canGenerate/needsReoptimization/describeRecreationStatus 全部改派生判定；markOptimizing 从已对齐状态补修订（强制重优化失败仍拦截）；buildGenerationCarry 增 personReferencePath。
- `promptOptimizer.ts`：KNOWN_DIMENSION_KEYS + 系统提示词规则 5/6（subject 与 clothing 独立判定、人物参考服装遵循服装处理指令）。
- `useVisionWorkspaceStore.ts`：snapshot 增 modificationDraft（含旧 adjustmentInput 迁移与 revision 归一化）。
- `carryApply.ts`：i2i 参考图追加人物参考（第二张）。
- 测试：vitest 757（新增 modificationIntent 22 / visionViewState UI-only 矩阵 11 / clothing 协议 4，更新 recreationPlan / dimensionIntent / workspace / copy / simplification / provenance / imageSource / poseBatch 对齐新模型）；tsc + build 全绿；cargo 176。

## Skill 3.0.0 / UI System 1.2.0（2026-08-23，GUI 实机验收收口：重复大图 / Viewer 交互 / 来源 provenance / Prompt 去重）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **image-viewer.md**：新增 §0 强制规则——页面不重复放置大图（Thumbnail 点击统一进 Viewer）、Backdrop click closes viewer、Wheel zoom only inside ImageViewport、Viewer keyboard listeners 仅打开期间存在、鼠标锚点缩放；§3 结构与事件作用域（Overlay → 有界 Viewport → Topbar/Toolbar/Detail stopPropagation）。
- **visual-workflow.md**：§2 FinalPromptEditor 是唯一 Prompt Editor（禁止「编辑生成方案」第二编辑区；Final View / Diff View 同空间切换；四态徽章含 manual）；§6 生成结果区删除 SelectedResult 大图布局（缩略图 + 评价跟随选中，全宽）。
- **patterns.md**：§14.12 改为「评价跟随选中缩略图，页面无重复大图」；§15 更新 Prompt Provenance 要点；§16 补四条 Viewer 强制规则；新增 **§17 Image Source Provenance**（Local ≠ default fallback、生成资产继承任务来源、「本地」白名单、resolveImageSource 唯一 resolver）。
- **components.md**：FinalPromptCard → FinalPromptEditor；PromptDiff 移入修改对比 Tab；新增 resolveImageSource 行；ResultThumbnail 注明点击进 Viewer。
- **copy.md**：新增 §9 图片来源词表（本地/文生图/图生图/编辑结果/批量结果/视觉复刻/生成结果）；§8 增「最终版本」「Prompt 已手动修改…」并禁双编辑区。
- SKILL.md：版本 3.0.0，索引更新 05/06/09/10 描述。

配套代码（V4.1 GUI 验收修复）：

- `src/features/evaluation/VisionResultSection.tsx`：删除页面内 SelectedResult 大图（stage/导航/提示）；缩略图点击 = 选中 + 进全局 Viewer；评价全宽跟随选中缩略图。
- `src/components/ImageViewer.tsx` 重写交互层：遮罩 onClick 关闭（视口内点图片外暗区也关闭；拖拽后抑制）；滚轮缩放只绑定 viewport（非 passive + preventDefault）且以鼠标为锚点；键盘监听仅打开期间；缩放/平移数学提取 `src/components/imageViewerTransform.ts`（applyZoom 锚点不变式 + clampScale，单测锁定）。
- `src/utils/imageSource.ts`（新）：resolveImageSource 唯一来源 resolver（任务继承 > 记录缺失生成 > library_input 本地 > 扫描生成；linked task 绝不本地）；Gallery 卡片/详情/筛选全部接入，筛选 Tab 增「视觉复刻」。
- Rust `commands.rs`：classify_source_kind 最长目录前缀优先（嵌套目录不再误判）；sync_images 不再覆写任务关联行 source_kind（+4 单测）。
- `src/pages/VisionUnderstanding.tsx`：删除「编辑生成方案」折叠 textarea；FinalPromptEditor（最终版本可编辑 / 修改对比 Diff / 复制；manual 状态徽章）成为唯一 Prompt 编辑器；提交链 promptDraft → carry 不变。
- 测试：imageSource（13）/ imageViewerTransform（7）/ imageViewer.interaction（12）/ gallerySourceProvenance（4）新增；visionPromptProvenance / visionSimplification / recreationCopy / promptDiff 更新；全量 vitest 696 / cargo 162 / build 通过。

## Skill 2.2.0 / UI System 1.2.0（2026-08-23，Visual Workflow UX 收口 + 内置 ImageViewer）

Token 层（App.css，双主题成对新增）：

- `--diff-added` / `--diff-added-bg` / `--diff-removed` / `--diff-removed-bg`（Prompt Diff 语义色，success/danger 派生）

规则层：

- 新增 **visual-workflow.md**（视觉理解复刻工作流专项）：Prompt Provenance（显示值===提交值）、失败不吞成功（使用上一次 Prompt）、Dimension Lock 三来源优先级（User Override > Modification Intent > Default）、Prompt Diff 双层（维度 Diff 默认 + 全文 Diff 折叠）、WorkflowStatusBanner（状态点+标签+引导语，CTA 在 Banner 外）、ResultGallery + SelectedResult 布局、收藏/满意语义分离。
- 新增 **image-viewer.md**（内置图片查看器专项）：接入范围（可预览 vs 不接入）、openViewer 唯一入口与 ImageViewerItem 契约、缩放/平移/多图/复制二进制/另存为、快捷键全表、生成图必须携带提交 Prompt 快照、渐进迁移路径。
- patterns.md：§14 Evaluation Pattern 增补 11/12 两条（收藏分离 / 评价紧邻图片）；新增 §15 Visual Workflow Pattern、§16 Image Viewer Pattern。
- components.md：公共组件新增 ImageViewer；业务组件新增 WorkflowStatusBanner / FinalPromptCard / PromptDiff / DimensionCard / ResultThumbnail / FavoriteButton。
- copy.md：新增 §8（最终 Prompt / Diff / 维度锁定）、§9（收藏 / 图片查看）术语表。
- tokens.md：Status 表补 diff.added / diff.removed。
- SKILL.md：索引新增 09 visual-workflow / 10 image-viewer。

配套代码（V4.1 视觉理解复刻工作流 UX 收口）：

- `src/features/vision/recreationPlan.ts`：RecreationPlanField 增 lockSource / originalValue；applyDimensionIntent（意图落位 + user_override 优先）；revertToLastSuccessfulPrompt / hasSuccessfulPrompt；describeRecreationStatus 失败态提示回退。
- `src/features/vision/promptDiff.ts`（新）：tokenizePrompt（CJK 逐字/拉丁按词/标点稳定）+ computePromptDiff（前后缀裁剪 + LCS + 超限整体替换兜底）+ dimensionDiff。
- `src/services/promptOptimizer.ts`：复刻优化协议扩展 changed_dimensions / dimension_values；用户内容三档锁定标注（手动锁定/手动开放/自动判断）；移除 lockedFields 输入（由 plan.lockSource 派生）。
- `src/components/ImageViewer.tsx` + `store/useImageViewerStore.ts` + `utils/imageClipboard.ts`（新）：全局内置查看器（10%~800% 缩放 / 平移 / 多图循环 / 复制二进制 / Tauri 另存为 / 全快捷键），App 单例挂载。
- `src/pages/VisionUnderstanding.tsx`：最终生图 Prompt 卡（三态徽章 + 查看/复制/修改对比）、全文 Diff、维度卡（已修改态 + 原/新红绿对比 + ·手动标识）、状态栏升级（状态点 + Banner 外「使用上一次 Prompt」）、参考图进查看器。
- `src/features/evaluation/VisionResultSection.tsx`：ResultGallery（hover 查看/收藏 + ♥ 角标）+ SelectedResult 左右布局（大图 | EvaluationPanel sticky，≤1280 堆叠）+ 生成图 Viewer 条目携带提交 Prompt 快照。
- `src/features/evaluation/EvaluationPanel.tsx`：评价长文本 2~4 行折叠 + 「查看完整评价」。
- 收藏后端：Rust `evaluation.rs` favorite 列（幂等 ALTER 迁移）+ set_image_favorite 命令（未评价资产可收藏）；TS store 乐观更新。
- `src/pages/ImageStudio.tsx`：参考图 Tile 点击从系统打开改为内置查看器（多图导航）。
- 测试：promptDiff（12）/ dimensionIntent（15，含 §69 意图矩阵与手动锁定优先级）/ useImageViewerStore（4）/ visionPromptProvenance（10，显示值===提交值守卫）/ 优化器协议扩展；全量 vitest 657 / cargo 158 通过。

## Skill 2.0.0（2026-08-22，Media Input Pattern）

规则层（无 Token 变更，UI System 保持 1.1.0）：

- patterns.md：新增 **§11 Media Input Pattern**（8 条规则 + empty/loaded/multiple/dragOver/disabled/error 状态机）；原 §11 Gallery Picker 顺延为 §12。
- components.md：业务组件表新增 `ReferenceImageInput`（含复用方向：人物/场景/产品/首尾帧/风格/视频参考）。
- examples.md：Golden Sample 表新增「标准媒体输入（MediaInput）」条目（含两条禁止项）。

配套代码（V4.0.8 参考图载入 UI 重构，仅 UI）：

- `src/pages/ImageStudio.tsx`：`SourceImagePicker` → `ReferenceImageInput`——Empty（整体可点 Dropzone，min-height 128px，键盘可达）与 Loaded（96px Tile + 扩展名徽标 + Add Tile 弹出 本地/图库 菜单）互斥；移除钮改 neutral 遮罩 Hover danger（Tooltip 移除参考图片）；文件名只进 Tooltip；字段头新增「已选 N 张」；AI 优化按钮移入提示词字段头（四态：secondary 可点 / disabled / 优化中 / Brand Soft 已优化）。
- `src/pages/ImageStudio.css`：`studio-media-*` 体系替换 `studio-source-*`；Dropzone 紧凑化；drag-active 双态反馈；`studio-prompt-head` 字段头。
- 测试：`imageStudioUi.test.ts` 新增 6 例 MediaInput 契约（Empty/Loaded 互斥、secondary danger、文件名仅 Tooltip、Dropzone 尺寸区间、DragOver 反馈、AI 优化四态）。

## UI System 1.1.0（2026-08-22，图片生成页 Golden Sample）

Token 层（App.css，双主题成对新增，无存量值变更）：

- `--bg-section`（卡片内嵌面板：light #f8f9fa / dark #242424 下沉式）
- `--card-shadow`（卡片浮起：light 双层微影 / dark `none`）

规则层：

- tokens.md：Surface 表补 surface.section / card-shadow；新增 **Brand 强度三档**（Strong=CTA 实底 / Medium=accent-primary-text / Soft=accent-primary-light 底），禁止 Strong 档用于选择态与数字信息。
- layouts.md：新增 §4 Creator Workspace（max-width 1600、grid minmax(0,1fr)+320px 侧栏、≤1200px 单列、无步骤编号、TaskSidebar 单卡容器）。
- patterns.md：新增 §10 Creator Workspace Pattern（ModeControls / PrimaryInput / OptionalInput / GenerationSettings / TaskSidebar 结构与状态规则）。
- examples.md：Golden Sample 表新增「Creator Workspace Golden Sample」（ImageStudio.tsx + 12 例契约守卫）。

配套代码（V4.0.8 UI 精修）：

- `src/pages/ImageStudio.tsx`：单张/批量共用 GenerationSettings、摘要+CTA+最近任务收进 TaskSidebar、Segmented 模式条、AI 辅助胶囊、上传区四级结构、最近任务状态点+状态词；显式 import Settings.css（修复懒加载 chunk 样式缺失），移除 CreateTask.css 依赖。
- `src/pages/ImageStudio.css`：整体重写（语义 Token 化，清除全部硬编码 hex/rgba 与未定义 var 兜底）。
- `src/components/BatchPlans.css`：页面布局类样式迁出至 ImageStudio.css（studio-*），保留卡片/抽屉/确认弹窗家族。
- 测试：`src/pages/__tests__/imageStudioUi.test.ts`（12 例 UI 契约）。

## 1.0.0（2026-08-22）

首个版本，从 V4.0.8 实际代码提取建立（未引入任何新视觉皮肤）。

- **SKILL.md**：效力声明、深色工作台 + Indigo 品牌的 Foundation、开发工作流（Token → Primitive → Business → Page）、最高优先级规则 10 条。
- **tokens.md**：App.css 双主题变量全量语义映射（surface/border/text/brand/status/badge）；Typography 10–22px 层级；Spacing 4/8/12/16/24/32（+6/18/28 过渡档）；Radius 4/6/8/10/12/14/999/50%；控件高度表（32/38/44/46 等）。
- **components.md**：共享按钮类 + 16 个公共组件清单 + Badge 体系（flex-shrink 0 + nowrap 铁律）+ 表单结构 + 渐进迁移等价表。
- **layouts.md**：App Shell（220px 主导航）、页面宽度策略（数据页铺满 / 表单页自定）、Chat 工作台三层结构（240px 会话栏 / clamp(780,48vw,1180) 内容宽 / 滚动归属）、弹窗与空态模板、响应式检查基准。
- **patterns.md**：模型选择 / 图片附件（含会话隔离铁律）/ 任务确认 / 任务状态 / 会话切换 / 空态 / 预览 / 加载错误重试 / 生成结果 / 图库选择器 10 个模式。
- **copy.md**：导航 9 项固定叫法、核心功能术语、状态词、计费整词表（API 按量计费 / Coding Plan 套餐）、标点混排、按钮动词。
- **model-selector.md**：Model UI Policy 架构与规则（registry recommended 策展 / primary 3~6 / 更多模型不丢入口 / deprecated 标注 / retired·missing·disabled 隐藏）、Dropdown UI 规则、触发按钮布局契约、测试守卫索引。
- **examples.md**：12 个 Golden Sample 索引 + UI Compliance Check 清单（Token/Components/Layout/Copy/Responsive/回归）。

配套落地（同版本）：
- `src/features/aiProviders/modelUiPolicy.ts`（策略）+ `billing.ts`（计费 formatter）
- `src/components/ModelPicker.tsx` + `BillingBadge.tsx`（公共组件，样式自 Chat.css 迁出）
- `registry/glm.json` recommended 扩充至 4 个（旗舰/快速/免费/视觉）
- 测试：modelUiPolicy.test.ts + billingBadge.test.ts（21 例新增守卫）

## Skill 2.1.0（2026-08-22，AI Creative Workflow + Evaluation Pattern）

规则层（无 Token 变更，UI System 保持 1.1.0）：

- patterns.md：新增 **§13 AI Creative Workflow Pattern**（6 条规则：分析细节默认折叠 / 用户意图核心 / Prompt 属实现细节 / 视觉复刻默认 img2img / 高级参数折叠 / 路径只进 tooltip）与 **§14 Evaluation Pattern**（10 条规则：media-first / AI 评分与用户反馈分离 / Similarity≠Completion / per-image 评价 / 分数附属 Asset / 评价失败不影响生成 / 未评价≠0 分 / successful result 只记录 / 列表轻量展示 / 闭环只填充不自动触发）。
- copy.md：新增 §7 评价与创作工作流术语表（AI 评价 / 综合完成度 / 复刻完成度 / 修改意图 / 继续调整 / 满意·需要调整 / 六维固定名 / 八个反馈问题标签）。

配套代码（V4.0.9 统一图片评价系统 + 视觉理解简化工作流，ADR-012）：

- `src/features/evaluation/`：types / evaluationModel（权重与筛选纯函数）/ evaluationService（自动评价 watcher + 上下文组装）/ evaluationSettings（自动评价开关）/ EvaluationBadge / EvaluationPanel / VisionResultSection。
- `src/pages/VisionUnderstanding.tsx`：默认主流程压缩为 原图 → AI 理解（summary 常驻+详细折叠）→ 修改意图（核心区+Chip）→ AI 生成方案（自然语言常驻+折叠）→ 生成结果（评价闭环）→ 高级设置 ▾。
- `src/pages/Gallery.tsx`：评分桶/反馈筛选/评分排序 + 卡片徽章 + 详情 AI 评价区块；`src/pages/TaskQueue.tsx`：任务行评价摘要。
- Rust `src-tauri/src/evaluation.rs`：ImageEvaluation 持久化 + evaluate_image 等四命令。
- 守卫测试：`pages/__tests__/visionSimplification.test.ts`（12 例折叠契约）+ evaluation 系列 38 例。
