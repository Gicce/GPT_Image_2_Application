# Interaction Patterns（CyImagePro 交互模式）

> 记录 UI / Interaction Contract，不塞 Store 业务实现。同一交互全产品保持一种形态。

## 1. Model Selection（模型选择）

见 model-selector.md 专项规范。要点：集中策略、默认精简（3~6）、更多模型不丢入口、计费 Badge 整词。

## 1a. AI Model Routing（AI 功能模型路由，V4.1）

「哪个 AI 功能用哪个模型」的唯一规范见 `ai-model-routing.md`。要点：

- **任何 AI 功能取模型一律走 `resolveModelForRole(role)`**（`features/aiRouting/`）；禁止组件内 `selectedModel || defaultModel`、禁止硬编码模型 id 兜底、禁止静默继承其它功能的全局默认模型。
- **显示的模型 = 执行的模型**：功能入口旁的模型标签（如视觉页「Prompt 优化 · GLM-5V-Turbo · 跟随视觉理解」）与实际请求的模型来自同一次 resolve；fallback 必须带原因且 UI 可见（warn hint + Toast）。
- 设置页「AI 模型使用」（设置与更新 → AI 模型使用）：分组 Role Row（功能 / 模型 / Provider / BillingBadge / 配置来源 / 最近使用）+ 跟随（推荐）/ 单独指定 radiogroup + 按 role 能力过滤的 ModelPicker + 恢复推荐设置；external role 跳转既有设置页。
- 配置来源四词固定：`手动指定 / 跟随「X」 / 系统默认 / 当前回退`（copy.md §12）。

## 2. Image Attachment（图片附件 / 上下文栏）

- 入口统一：本地选择 / 拖入 / 图库 / 粘贴 四路都写进同一附件数据结构，绝不自动发送。
- 展示统一：Composer 上方「图片上下文栏 / 任务图片」横向卡片：缩略图 + 顺序标签（图一/图二/图三，删除自动重排）+ 来源（图库/粘贴/本地/上传）+ 单项移除 × + 清除全部。
- 拖拽反馈：drop-active 高亮 + 覆盖层提示「松开以添加图片」+ 支持格式说明。
- **会话隔离铁律：Conversation UI state 必须按 conversationId 隔离**（草稿、附件、active_image 均按会话 key 存取）；禁止 Page-level 全局附件导致跨会话污染。异步入口（读图/保存）必须在 await 前捕获目标会话。

## 3. Task Confirmation（任务确认）

- 任务模式提交 → WAITING_CONFIRM 任务卡（计划摘要 + 最终提示词 + 可修改 + 确认/取消）。
- 提案卡（AgentProposalCard）：原始需求 / 控行方式 / 源图数量 / 批量子项可勾选。
- 危险或不可逆操作 → Dialog 确认（删除会话/任务用 Delete*Dialog，标题 + 说明 + busy 态按钮）。

## 4. Task Running / Completed / Failed（任务状态展示）

- 状态词统一见 copy.md（生成中/等待确认/已完成/失败/已取消）。
- 任务卡内：进行中 = 进度/占位动画；完成 = 结果图卡（点击预览大图 + 操作）；失败 = 错误信息 + 重试/重新规划按钮。
- 结果图操作固定顺序：预览 / 编辑此图 / 再来一张 / 查看任务。
- 消息流任务卡与全局 TaskQueue 状态必须一致（事件桥 + reconcile，UI 层只消费 store）。

## 5. Conversation Switching（会话切换）

- 切换 = 读该会话独立草稿/附件/模式/模型绑定；滚动位置回底部。
- 重命名：双击标题；删除：Dialog 确认；空态：「暂无对话」引导。

## 6. Empty State（空状态）

统一结构：居中主文案 16px（+ 引导 hint 13px + 主动作按钮可选）。禁止只放一个旋转图标或空白。

## 7. Image Preview（图片预览）

全屏 overlay 模态：头部元信息（文件名/分辨率/时间）→ 工具条（复制图片/保存/设为头像/系统打开原图/关闭）→ 大图。
Esc 关闭、Ctrl+C 复制当前预览图。

## 8. Loading / Error Retry

- 局部加载：占位/进度文案（「正在检索图库…」带 progress 条）。
- 错误横幅（chat-error）：文案 + 复制 + 关闭；可重试的横幅加重试按钮（chat-model-error 模式）。
- 轻量操作反馈：Toast（成功/失败）；关键表单错误：inline error。
- 异步操作按钮：disabled + busy 文案（「设置中…」「正在创建任务...」），防重复提交。
- **AI 结构化响应错误的呈现铁律（V4.0.9）**：
  - Internal transport / parser / schema errors MUST NEVER be exposed directly in user-facing UI（serde / JSON / schema / invalid type 类词只进开发日志）。
  - Hiding an error message is NOT error recovery —— 先在数据层完成 normalize → validate → 最多一次 repair，UI 层只做 `mapVisionErrorToUserMessage` 式映射 + 技术信息拦截（视觉理解实例：`src/features/vision/visionErrors.ts`）。
  - 失败保留旧成功结果（禁止整页回空状态）；失败后重试入口立即可用。

## 9. AI Generated Result（生成结果）

生成图卡：点击看大图 overlay（「点击查看大图」hover 提示）；Prompt 展示用 PromptTextBlock / prompt-block（复制按钮）；消息底部 Token 角标。

## 10. Creator Workspace（创作页工作台，V4.0.8 图片生成页验证）

```text
PageHeader（22px 标题 + 13px 说明）
ModeControls（Segmented Control × 生成方式/生成模式 + AI 辅助胶囊，右对齐）

WorkspaceGrid
├─ CreatorMain（.settings-card.studio-card，页面视觉主体）
│  ├─ AssetInput（参考图片 ImageUploadZone：图标→主文案→操作→支持格式 四级）
│  ├─ PrimaryInput（提示词/编辑需求/批量需求，studio-textarea-lg）
│  ├─ OptionalInput（负面提示词 = Secondary Field：Label 降一级 + sm 高度）
│  ├─ Plans / 方案列表（批量专属，BatchPlanCard）
│  └─ GenerationSettings（surface.section 面板：尺寸|质量|格式 一行 + 目录行）
│
└─ TaskSidebar（单卡片容器，sticky）
   ├─ TaskSummary / GenerationStats（键值行 or 2×2 StatCard + Primary CTA）
   └─ RecentTasks（状态点+状态词+进度；标题 ellipsis；列表内滚）
```

规则：

- 单页表单不显示步骤编号；模式差异只通过 Section 增减表达。
- Primary CTA 永远在 TaskSidebar（sticky 常驻可见）；Disabled = 降不透明度保持可读。
- AI 次级 CTA 用 Brand Soft 档，介于 Primary CTA 与 Text Action 之间。
- StatCard 数字默认主色，仅 待完善>0（warn）/ 全部就绪（success）/ 最终结果（Brand Medium）按状态提亮；0 态降噪。
- 最近任务状态必须「点 + 状态词」双通道，禁止只靠颜色或 ✓/× 字符。

## 11. Media Input Pattern（ReferenceImageInput，V4.0.8 图片生成页验证）

媒体（参考图/首尾帧/风格参考等）输入组件的统一形态。实例：`src/pages/ImageStudio.tsx` 的 `ReferenceImageInput`（单张/批量图生图共用）。状态机：`empty / loaded(单图或多图) / dragOver / disabled(预留) / error(占位)`。

### Rule 1 —— Empty 和 Loaded 是两个不同 UI State
Empty = 可点击 Dropzone（整体可点、高度 120~140px、图标→主文案→操作→支持格式四级）；载入后组件整体切换，不是叠加。

### Rule 2 —— 已有素材后禁止继续同时展示完整 Empty Dropzone
Dropzone 只在 `images.length === 0` 分支渲染；继续添加走 Add Tile。

### Rule 3 —— 已载入媒体必须成为组件视觉主体
Tile：图片 96×96 / `object-fit: cover` / radius 8 / Token 边框；图片可点击预览。

### Rule 4 —— 删除属于 secondary danger action
默认 neutral（`--bg-overlay` 遮罩圆钮），Hover 才 `--accent-danger`；Tooltip「移除参考图片」；禁止常驻高饱和红。

### Rule 5 —— 文件名属于 metadata，不属于主要信息
完整文件名只进 Tooltip；可无成本获得时用扩展名徽标（`--badge-muted-*`）代替；尺寸等元数据仅在数据链路天然可全量获得时展示，不为 UI 改上传链路。

### Rule 6 —— 多媒体用 Media Tile + Add Tile
Add Tile（虚线 96×96，「＋ 添加图片」）承载继续添加：弹出 从本地选择 / 从图片库选择；不恢复大 Dropzone。

### Rule 7 —— Drag Over 必须具有明确反馈
Empty 态：Dropzone 虚线描边转品牌色 + 品牌色底 + 标题切换「松开即可添加参考图片」。Loaded 态：Tile 网格外描边 + Add Tile 品牌高亮。

### Rule 8 —— 尺寸必须根据实际工作流控制
媒体输入是表单的一个 Field，不是页面主角；Empty Dropzone 与 Tile 网格都必须紧凑，禁止无意义占半屏。

复用方向：人物参考 / 场景参考 / 产品参考 / 首帧 / 尾帧 / 风格参考 / 视频参考。颜色一律语义 Token，禁止新 hex。

## 12. Gallery Picker（图库选择器）

网格翻页（3x3/4x4 切换、排序、来源过滤）；选中态 = 描边 + overlay + ✓ badge + 顺序标签四重视觉；再次点击取消选中；缺失文件置灰不可选。

## 13. AI Creative Workflow Pattern（视觉理解简化工作流，V4.0.9 验证）

「理解媒体 → 告诉 AI 怎么改 → 生成 → 评价 → 反馈 → 再生成」类创作页面的统一形态。实例：`src/pages/VisionUnderstanding.tsx`（视觉理解页）。规则：

1. **Analysis details 默认折叠**：AI 理解只常驻一段自然语言 summary（「AI 已理解这张图片」）；八维结构化分析 / 技术细节全部收进「查看详细分析 ▾」。数据层保留全量，只是不平铺。
2. **用户意图是工作流核心**：意图输入区（「你想怎么修改这张图片？」）是页面主操作区，紧邻主 CTA；快捷 Chip 是结构化维度选择器（V4.1 起 Modification Dimension Selector：toggle / 唯一槽位 / 不向 textarea 追加文本），自由文本与结构化意图并存。
3. **Prompt 属于实现细节**：默认展示自然语言方案（「AI 生成方案」）；Full Prompt / Negative Prompt / 原始 Prompt 折叠进「编辑生成方案 ▾」与「高级设置 ▾」。
4. **Visual Replication 默认 img2img**：参考图场景默认携带原图走图生图（保持主体一致性优先）；文生图/图生图切换收进高级设置（能力不删，只降暴露）。
5. **高级参数全部折叠**：模型选择、模式、Seed/强度类参数、生成方式、生成参数统一进「高级设置 ▾」（默认收起）。
6. 源文件只显示尺寸/来源/更换入口，**绝对路径只进 tooltip**。

## 14. Evaluation Pattern（统一图片评价，V4.0.9 验证；V4.1 补收藏语义）

生成结果 / 资产筛选场景的评分与反馈统一形态。实例：`src/features/evaluation/`（EvaluationBadge / EvaluationPanel / VisionResultSection）。规则：

1. **Generation Result 必须 media-first**：结果图网格 + 右上角轻量评分徽章（一个数字 + 👍）；六维明细/文字结论只进「查看评价」展开的 EvaluationPanel，禁止在图片上堆多个数字。
2. **AI score 与 User Feedback 永远分离**：评分区（综合完成度 + 六维 + 优势/问题/建议）与反馈区（👍 满意 / 👎 需要调整 + 问题标签 + 补充说明）是两个独立区块、独立落库字段。
3. **Similarity ≠ Completion**：评分口径是「任务完成度」不是「与原图相似度」——用户要求修改的部分与原图不同是正确行为；UI 文案用「AI 评价 / 综合完成度」（视觉复刻页「复刻完成度」），禁止叫「图片质量分」。
4. **Batch result 必须 per-image evaluation**：一个任务 N 张图每张独立评分；任务行/聚合视图只显示「4 张 · 最高 93」式摘要。
5. **Score 附属于 Asset，不是仅 Task**：评价绑定图片资产行（asset_id），任务层 best/average 只是聚合视图。
6. **评价失败不得导致生成失败**：评价是生成完成后的异步动作；失败显示「暂无评价」+「重新评价」，绝不影响任务状态。
7. **未评价 ≠ 0 分**：null 与 0 是两个语义（0 是合法低分）；筛选器必须同时提供「未评价」桶。
8. **用户满意结果可记录为 successful result**（liked）：只记录，不做自动训练 / 自动改 Prompt。
9. **列表评分轻量展示**：图库卡片 / 任务行只放徽章或摘要，不允许抢媒体视觉权重。
10. **反馈闭环只填充不自动触发**：「继续调整」把上轮评价+反馈组装进意图输入框，由用户确认执行。
11. **（V4.1）收藏与满意分离**：`♡/♥ 收藏` = 精选标记（image_evaluations.favorite，未评价资产可收藏）；`👍 满意` = 对本次生成的反馈；`👎 需要调整` = 问题反馈入口。三者语义禁止混用；反馈类按钮是 Toggle Action（secondary），永远不占 Primary CTA。
12. **（V4.1）评价跟随选中缩略图，页面无重复大图**：结果区只渲染缩略图网格 + EvaluationPanel（选中图的评价）；查看大图统一进全局 ImageViewer。评价长文本默认 2~4 行 +「查看完整评价」展开。

## 15. Visual Workflow Pattern（视觉理解复刻工作流，V4.1）

Understand → Modify → Optimize → Review Prompt → Generate → Evaluate → Feedback → Iterate 的统一形态，专项规范见 `visual-workflow.md`。要点：

- **UI-only interaction MUST NOT dirty semantic state.（强制铁律）**：Collapse / Expand / Tab / Viewer / Selection-only actions are view state. They MUST NOT change semantic revision or Prompt provenance. 折叠 / Tab / Viewer / 选中缩略图等视图操作统一放 `useVisionViewStore`（进程内、不持久化），语义状态（modificationDraft / recreation 修订 / Prompt 产物）唯一载体是 workspace store；`needsOptimization = semanticRevision !== optimizedRevision` 派生判定，禁止任何写入方私设粘滞 dirty 标记。
- **FinalPromptEditor 是唯一 Prompt Editor**：页面唯一「最终生图 Prompt」概念，显示值 === 提交值（同一数据源 promptDraft）；Final View（可编辑）/ Diff View（修改对比）同一空间切换；禁止 Final Prompt + 「编辑生成方案」两个编辑区并存。
- **快捷修改按钮是 Modification Dimension Selector**：结构化 toggle（同一维度唯一槽位、多维度可并存、「提高复刻度」独立开关），禁止向 textarea 追加「修改XX：」文本；选中态从 modificationDraft 读取。
- **人物替换 / 服装策略结构化**：三种人物来源（图片库人物 / 本地导入 / 文字描述）+ ClothingPolicy 三选一；服装是独立第九维度（clothing），与 subject 区分判定。**（V4.0.9.1 状态不变量）clothingPolicy=preserve_original and clothing=modified is an invalid semantic state**：`clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'`，唯一归一入口 `normalizeModificationState`（toggle / setClothingPolicy / clearPersonReplacement / 持久化恢复 / store setter 全部经过）；「原图服装」自动取消「修改服装」Chip，「人物服装 / 自定义」自动启用；custom 空描述用 `clothingReadinessError` 拦截优化与生成；「可修改 N」计数以 activeDimensions 为单一事实源。
- **生成溯源快照（V4.0.9.1）**：User instruction, structured modification plan, and final execution prompt are three distinct provenance layers and MUST NOT be conflated。「确认生成图片」冻结 `GenerationProvenanceSnapshot`（userInstruction / modificationIntent / imageRoles / models）随 Task 落库；历史任务详情四层结构（用户要求 / 本次修改方案 / 参考图片 / 最终执行 Prompt + 模型执行记录），旧任务无快照如实「未保存」、参考图只编号不猜角色；任务来源=视觉复刻（`task_source='vision_recreation'`，与生成方式两维度并存）；所有参考图与结果图点击进全局 ImageViewer。详见 visual-workflow.md §1h。
- **失败不吞成功**：优化失败只影响「最近一次尝试」，lastSuccessfulPrompt 原样保留；Banner 外提供「使用上一次 Prompt」回退。
- **Dimension Lock 三来源优先级**：User Override > Modification Intent > Default Preservation；修改意图来自 AI 结构化输出（changed_dimensions，九维含 clothing），禁止前端 includes() 猜维度。
- **Prompt Diff 双层**：维度 Diff（原/新红绿对比）默认；全文 Diff 在 FinalPromptEditor「修改对比」Tab；+/− 前缀 + 删除线 + Token 颜色三通道。
- **WorkflowStatusBanner**：状态点 + 标签 + 引导语（gray/green/orange/blue/red 五 tone）；CTA 在 Banner 外。

## 16. Image Viewer Pattern（内置图片查看器，V4.1）

全项目「可预览图片」点击统一进入全局 `<ImageViewer />`（App 单例），专项规范见 `image-viewer.md`。要点：

- 打开唯一入口 `useImageViewerStore.openViewer(items, index)`；可预览图 cursor: zoom-in。
- **页面不重复放置大图**：Thumbnail / Image Card 点击统一进 Viewer（缩略图 + 选中态留在页面）。
- **Backdrop click closes viewer**（遮罩 / 视口内图片外暗区）；顶栏 / 工具栏 / 详情面板 stopPropagation。
- **Wheel zoom only inside ImageViewport**（鼠标位置锚点缩放）；其它区域滚轮正常滚动，禁止 window/document 级 wheel 缩放。
- **Viewer keyboard listeners exist only while Viewer is open**（关闭即解绑，不影响页面输入框）。
- 缩放（10%~800% 钳制）+ 平移（zoom > fit，grab/grabbing）+ 适应窗口 + 100% + 多图循环切换 + 复制二进制 + Tauri 另存为。
- 生成结果必须携带该张实际提交的 Prompt 快照（task.final_prompt / batch_items.prompt_override）。
- 渐进迁移：新页面一律接入；Gallery / Chat / History 存量预览改造到哪个页面哪个接入。

## 17. Image Source Provenance（图片来源真实可信，V4.1）

图库资产「从哪来」的唯一 resolver：`src/utils/imageSource.ts`（`resolveImageSource`）。规则：

- **All user-visible source labels MUST resolve through `resolveImageSource()`**：卡片角标 / 筛选桶直接消费 resolver；详情 Modal 与 ImageViewer metadata 一律经 `features/gallery/imageDetailMetadata.ts`（`resolveImageDetailMetadata`，内部复用 resolver），页面 / 组件禁止自读 source_kind / task_id / pose_batch 拼来源。
- **Gallery Card / Filter / Detail / Viewer source labels MUST never diverge**：同一 ImageRecord 在四个 surface 的来源解释必须一致（动作白膜统一为 来源=CY Video Studio + 用途=动作白膜）。
- **来源 Source 与用途 AssetType 分离**：来源回答「从哪里进入 CyImagePro」，用途回答「在业务里是什么」（动作白膜 / 参考图类）；用途只有真实业务 metadata 才显示，禁止默认「类型：生成结果」，禁止「类型 / 来源类型 / 生成类型 / 资产来源 / 图片来源」label。
- **Local ≠ default fallback**：禁止 `source ?? 'local'` / `origin || 'local'` 式兜底；source 缺失或目录误判时绝不能假装图片是本地导入。
- **生成资产必须继承任务来源**：优先级 = 关联任务（视觉复刻 source_task_id → vision_understanding 最优先，其次批量，再任务类型 generate/edit/remove_background）> 任务关联但记录缺失（生成结果）> library_input 索引行（本地）> 输出目录扫描行（生成结果）。
- 「本地」只允许：用户手动导入 / 拖入 / 复制进图库本地目录（library_input 且无任务关联）的文件（微信 / QQ / 下载 / 桌面等外部源路径拖入后即本地，禁止按路径关键词细分）；**linked task 的资产永远不得显示为本地**。
- 中文来源词固定（copy.md §9 + §9a 详情字段名）：本地 / 文生图 / 图生图 / 编辑结果 / 批量结果 / 视觉复刻 / 生成结果；筛选 Tab 与来源桶一一对应。
- 旧资产恢复优先读取时 resolver 推导（任务关系），必要时才做最小幂等 migration；Rust `classify_source_kind` 按**最长目录前缀**判定（本地目录与输出目录配置成同一路径时平局归 library_input——无任务索引行只能来自用户导入），`sync_images` 不得覆写任务关联行的 source_kind。

## 18. Gallery File Drop Pattern（图片库 OS 拖拽导入，V4.1）

**OS File Drop on Gallery → explicit local import。** 实例：`src/pages/Gallery.tsx` + `src/hooks/useGalleryFileDrop.ts` + `src/features/gallery/galleryFileDrop.ts`。规则：

1. **Gallery drag import must reuse the canonical library import pipeline.** 唯一入库链路是 Rust `import_images_to_library` → `sync_images`（与手动把文件放进 `library_input_dir` 完全同一条索引链路：`task_id="library"`、`source_kind=library_input`）；禁止页面 / Hook / Overlay 内自建第二套索引写入或来源判定（无 `invoke('import_images_to_library')` 之外的通道，无 `source_kind` 写入）。
2. **Local is explicit provenance, never a generic fallback.** 拖入 = 显式本地导入（library_input 且无任务关联）；「本地」白名单与禁 local 兜底见 §17，拖拽功能不得新增 `if (dragged) return '本地'` 类页面级来源逻辑。
3. **作用域 = Gallery 路由**：拖拽监听只在 Gallery 页挂载（路由级切换自动卸载）；其它页面（AI 智能体 / 图片生成 / 视觉理解等）拖图片绝不触发图库导入。**Active Modal > Gallery File Drop**：详情 Modal / 全局 ImageViewer 打开时 `enabled=false` 并复位拖拽态。
4. **一次松手 = 一次导入**：controller `processing` 防重入（processing 中 enter 不激活 overlay、drop 整体忽略）；Tauri `onDragDropEvent` 为窗口级事件（无子元素 dragenter/dragleave 闪烁问题），事件翻译统一走 useGalleryFileDrop，与 useImageDrop / 视觉理解页同一条 Tauri 原生通道，不依赖 HTML5 `dataTransfer.files`。
5. **外部文件必须复制进管理目录**（绝不永久引用 Downloads 等外部路径）；已在管理目录（library_input_dir / 输出目录）内或同名同内容（md5）→ 跳过不复制、仅刷新索引，绝不产生 `photo (1).png` 副本；**重名策略只存在于导入命令内**（不同内容 → `girl (1).png` 后缀，Windows 资源管理器同形态），页面 / 前端禁止自拼副本后缀。
6. **多文件 / 混合文件**：单文件失败不中断整批；结果如实分桶 `imported / skipped / failed`，Toast 文案来自 copy.md §11（「已导入 7 张，1 张失败」+ 失败明细独立 Toast），禁止伪百分比进度。
7. **导入完成后的图库状态**：刷新只接受 Rust 重扫返回的全量列表（`useImageStore.applyImages`），不 push 到数组头、不偷偷切换用户当前筛选 / 排序——本地新资产只出现在「全部」（本地无独立筛选 Tab），来源 Badge「本地」由 resolver 的 isLocal 决定。
8. **Overlay 形态**：覆盖 Gallery 主内容区（`.gallery-page` 定位上下文，不遮左侧主导航），Brand Indigo 虚线框 + Brand Soft 底 + 导入图标 + 轻微 fade/scale（0.12s，reduced-motion 降级）；`pointer-events: none` + `role="status"`，文案与数量（「释放即可导入 6 张图片」「可导入 4 张图片 · 2 个文件不支持」「没有可导入的图片」）由 `galleryDropOverlayCopy` 唯一产出，Overlay 是纯 UI 组件。

## 19. Image Mention Pattern（@图片引用，V4.0.9 视觉理解验证）

**@ in Vision Workflow → real image reference bound to the current task image pool.** 实例：`src/features/vision/IntentMentionInput.tsx` + 纯函数层 `imageMention.ts`（弹层 / chips / 语义解析全链）。规则：

1. **@image mentions MUST resolve from current task/conversation images first.** 候选唯一来源 `buildVisionContextImages`（主参考图 + 人物替换参考 + 图库附加参考 + 本任务生成结果；同路径去重 + 业务标签：人物参考 / 主参考图 / 生成结果 N / 图片引用）；人物参考已设置时置顶。弹层条目 = 缩略图 + 名称 + 用途说明 + 角色标签（禁止只显示「图1 / 图2」）。
2. **Mention 是真实引用**：token 在 freeText（持久化安全），绑定在 `draft.mentions`（assetId / path / role）；@ 弹层「从图片库选择…」把图加入 `extraImageRefs`（当前任务隔离）后插入。
3. **原生 textarea + 背景高亮层**：IME 安全（isComposing 不处理弹层键盘；禁止 contentEditable / 富文本编辑器）；高亮层与 textarea 同度量（padding / 字体 / 行高 / white-space），token pill 无额外 padding，滚动同步。
4. **纯视图操作不 dirty**：弹层开关 / ↑↓ / Enter 预览 / Esc / hover 绝不写 store、不触发 semanticRevision；只有插入 / 删除 mention（文本 + mentions 变化）走语义通道。
5. **双图角色语义**：`resolveImageMentionRoles` 把「把 @A 的人物换成 @B」映射为 A=template_reference / B=person_replacement_reference；优先级 用户显式面板选择 > 明确 Mention > 自然语言推断（序号按「图N」文件名 + 池序号匹配）；面板为空时以「已识别图片角色」建议条呈现（应用走正常语义通道，绝不偷偷覆盖）。
6. **优化器 payload 双图真实进入**：`collectOptimizerImageReferences`（模板 → 人物 → 其它，路径去重）+ `buildImageReferencesBlock` 清单（顺序 = image parts 顺序）；优化器系统提示词规则 6a：模板图延续画风 / 构图 / 背景 / 氛围，人物图仅身份特征，不得把模板图风格替换成人物参考图的写实风格。

## 20. Task Failure UX Pattern（V4.1 任务失败与重试 UX）

实例：`src/pages/TaskQueue.tsx` + `src/utils/taskFailure.ts` + `src/utils/taskState.ts` + `src/utils/taskNavigation.ts`。规则：

1. **Friendly error summary MUST be separated from technical diagnostics.** 失败卡默认只显示「⚠ 分类标题 + 一句话说明 + 行动建议 + 历史尝试次数 + [重新生成] [查看技术详情 ▾]」；HTTP 状态 / Provider Code / Endpoint / Request ID / Raw Message 只进「技术详情」折叠区（Raw Message 可复制），且必须保留——友好文案≠删除技术错误。
2. **分类唯一入口 `classifyGenerationFailure`**（canonical failure model）：新数据读 Rust 结构化 `SubTask.error_detail`（category 权威），旧数据按稳定文案前缀回落解析；category → 文案映射表唯一来源 copy.md §13。禁止页面 substring 自分类、禁止把 HTTP 500 报成「请求超时」（timeout 只认真实超时信号）。
3. **主任务状态聚合唯一入口 `deriveTaskState(task)`**：queued / running / completed / partial / failed / cancelled 六态全部从 sub_tasks 事实派生；后端 finalize 事件丢失 / 刷新失败时 UI 仍显示正确终态（1/1 失败 ≠ 生成中）。
4. **TaskQueue is operational status UI. History is full audit UI.** 任务队列只承担状态 / 进度 / 失败摘要 / 重试 / 时间；完整审计（用户要求 / 执行合同 / Prompt / 模型记录 / 错误全量）在历史记录详情。「查看任务详情」= `openTaskDetailFromQueue(taskId)` 深链（cyimage-navigate + `cy_history_focus_task_id`），复用同一套 Task Detail，禁止第二套详情弹层；长 Prompt 在队列中默认折叠。
5. **Terminal tasks MUST expose a terminal timestamp.** 终态任务（completed / partial / failed / cancelled）显示 开始时间 / 结束时间 / 耗时；唯一入口 `resolveTaskFinishedAt`（= completed_at 持久化值），旧数据缺失显示「—」，禁止 Date.now() 伪值；耗时 = finished − started，任一缺失不显示。
6. **终态按钮契约**：活跃任务只显示「取消任务」；终态显示「查看任务详情」（+ failed/partial 的「重新生成失败项 / 重试失败项」）；已有重做 / 编辑重发 / 删除保留为次级操作，不新增隐藏能力。
7. **Native browser/system alerts MUST NOT be used for task retry feedback.** 重试提交成功 / 失败一律应用内 Toast（`toastSuccess` / `toastError`）；提交失败的原始错误进 `console.error` 开发日志。
8. **重试只重跑失败 slot**：失败槽 pending → 重新执行；completed 槽的图片与计费绝不触碰；`attempt_errors` / `attempt_details` 历史保留（「尝试 N · 时间 · 标题 · HTTP 状态」分条展示，不挤一行）；手动重试后主任务派生态回到 queued/running，结束时间在再次终态后更新。

## 21. Credits Billing Pattern（CY 点数计费，V4.2）

- **计费单位唯一 = CY 点（credits）**。用户侧禁止出现第二套计价单位（美元成本/汇率换算不进用户界面）；旧 USD 字段仅作兼容镜像，页面禁止再以 `$` 作主展示。
- **钱包三类点数**：正式（paid）/ 试用（trial）/ 赠送（gift），总可用 = 三者之和；消费顺序 试用 → 赠送 → 正式（服务端 `consume_credits` 唯一裁决，客户端不做任何扣减预测）。
- **充值 = 人民币直购**：档位 ¥10/¥20/¥50/¥100 + 自定义 ¥ 输入；兑换率（¥1 = N 点）只从服务端 `packages.credits_per_cny` 读取，展示「支付 ¥X → 预计获得 Y 点」；确认弹层（应用内 Dialog，禁止系统弹窗）文案固定「确认充值 · Y 点」。
- **余额不足文案**：`点数不足，请充值后继续使用`（402 / QUOTA_EXHAUSTED，全局唯一）。

## 21a. Trial Entitlement Pattern（试用一次性领取，V4.2）

- 入口可见性唯一依据 = 服务端 `users.me.trial_available`（总开关 + 试用默认 Token 有效 + 该邮箱未领取过）；客户端禁止自行推断。
- 按钮文案 = `申请免费试用`；成功 Toast = `试用点数已开通：+N 点`；同邮箱重复领取由服务端 claim ledger 判定（409），客户端只透出服务端 message。

## 22. Generation Quote Pattern（生成前报价确认，V4.2 铁律）

- **所有付费图片生成入口在 authorize 之前 MUST 先取服务端报价**（`POST /api/billing/quote`），经全局 `QuoteConfirmDialog` 展示：模式 / 数量 / 单张 / 预计消耗 / 当前余额 / 生成后预计剩余；点数不足时确认按钮禁用并提示充值。
- 确认文案固定 `[确认生成 · N 点]`；取消 = 抛 `quoteCancelled` 错误，调用方静默返回（禁止当错误横幅弹出）。
- **客户端禁止 `数量 × 单价` 自行计价**：报价一律来自服务端；生成按钮上的价格标注（如 `开始生成 4 张图片 · 预计 200 点`）标注「预计」且数据源为服务端权益接口。
- 参数变化 → 重新报价（quote 10 分钟过期，authorize 携 quote_id 按冻结价计费）。

## 23. Wallet / Ledger Pattern（账户点数流水，V4.2）

- 「我的账户 → 点数流水」= 服务端 `GET /api/billing/ledger` 直出：充值 / 图片生成 / 生成退款 / 充值退款 / 试用赠送 / 迁移，中文标签由服务端下发（`type_label`），客户端不维护映射表。
- 方向约定：正数 = 入账（充值/退回/释放），负数 = 消费；RESERVED 预占行标注「（已预占）」。
- 任务卡计费列（TaskBillingBadge）：未结算显示 `预计 N 点`，结算后显示 `实际 M 点（退回 K）`；partial 释放 MUST 可见。

## 24. Pricing Transparency Pattern（价格透明，V4.2 铁律）

- **用户生成前 MUST 知道预计点数消耗；生成后 MUST 能看到实际消耗；失败释放 MUST 在流水中可见。**
- **采购成本 / 毛利率 / Provider 内部定价 MUST NOT 出现在普通用户界面**（仅管理后台授权接口）；客户端代码禁止引用任何成本字段。

## 25. Project List State Transition Pattern（项目行状态迁移，V4.2 铁律）

**Interactive list rows MUST preserve layout geometry across normal / confirm / loading states.**
（交互列表行在 普通 / 确认 / 加载 各状态之间切换时必须保持布局几何；状态变化绝不把内容列压成不可读宽度。）

实例：`src/features/vision/project/VisualProjectLibrary.tsx`（全部项目弹层）。规则：

1. 行内三区固定网格：`grid-template-columns: auto minmax(0, 1fr) auto`（缩略图 / 内容 / 操作）；内容列 `min-width: 0`，标题与 meta 行 `nowrap + ellipsis`。操作区可换行收缩（`flex-wrap: wrap` + `max-width` 上限），但绝不挤压内容列。
2. 确认态（如删除确认）**整体替换**操作区内容（`确认删除 / 取消`），禁止在原按钮组旁边追加按钮——追加会瞬间扩大操作列、把标题挤成竖排单字。
3. 删除确认态唯一事实源 = 列表级单值状态（`pendingDeleteProjectId`），禁止每张卡各自维护 `isDeleting`（多卡同时进入确认态 = 状态错位）。Escape / 取消 / 提交后回落 `null`。
4. 历史缺陷锚点：确认删除后标题「单字符纵向排列」= 操作区 `flex: 0 0 auto`（shrink 0）+ 确认态按钮**追加**导致；修复 = 三区网格 + 替换式操作区。

## 26. Billing Dialog CTA Pattern（计费弹层 CTA 层级，V4.2 铁律）

**When the primary action is blocked by a recoverable account state, the remediation CTA belongs in the footer action hierarchy.**
（当主操作被可恢复的账户状态阻断时，补救 CTA 必须进入 footer 操作区层级。）

实例：`src/components/QuoteConfirmDialog.tsx`。规则：

1. 点数不足时 footer 为三按钮层级：`[取消 secondary] [去充值 primary] [确认生成 disabled]`——补救动作（去充值）与主操作（确认生成）同居 footer，禁止把去充值孤零零放在明细行区域。
2. 余额不足时全弹层**只允许一个 primary**（= 去充值）；确认生成转 disabled 并带 title 说明；余额充足时不渲染补救按钮。
3. 明细区补足决策信息：不足时增加「还差 N 点」行（还差 = 预计消耗 − 当前余额，向下取整不小于 0）。
4. 去充值导航走全局事件 `cyimage-navigate { page: 'account', section: 'recharge' }`（App Shell 写 `cy_account_section` + 派发 `cy-account-section`；Account 页滚动到 `#account-recharge` 并短暂高亮）。可带一次性 returnContext（sessionStorage `cy_recharge_return`），账户充值区据此显示「返回继续生成」，消费即清。

## 27. Canonical Reference Pattern（同源实体统一引用，V4.2 铁律）

**The same source entity shown in multiple areas MUST share one canonical label / hover preview / viewer / status badge.**
（同一来源实体在多个区域展示时统一：label、hover 预览、查看器、状态徽标。）

实例：`src/features/vision/project/effectivePlan.ts`（Effective Plan 行 + refs）、`animeCharacter.ts`（Canonical Anime Character）。规则：

1. 同一实体（人物参考图 / 动漫角色卡）在不同 UI 区域（Context Rail 行、Skill Trace、History、确认弹层）出现时，展示名与徽标一律来自同一构建入口（如 `buildPlanSourceRef` / `AnimeCharacterSnapshot`），禁止各组件自行拼装第二份描述。
2. hover 预览绑定真实图片路径（refs 侧车），无图片时 fullLabel 承载摘要文本；实体是派生概念（如动漫角色卡）时，预览回落到其身份来源图 + 摘要 roleNote。
3. 状态徽标语义固定：`已替换（success）/ 不保留（warn）/ 🔒 已锁定`；锁定类摘要（如 `🔒 已统一角色卡`）只在存在真实冻结合同时出现，禁止装饰性锁标。
- 扣费标准弹窗：单张 N 点（约 ¥X）+ 费目明细（每笔 M 点）；旧 `$` 口径仅历史数据回退显示。

## 28. Detail Group / Instance Pattern（V5 铁律）

- `RenderingRegion` 是插图组，`DetailInsertInstance` 才是画面中的真实画框；计数、角色绑定、Prompt 行、Skill Trace 与历史快照全部按 instance 展平，禁止用组数冒充插图数。
- 一个组可同时包含动漫、真人与图形实例：仅动漫实例绑定 Canonical Anime Character；真人与图形实例镜像所属主体，不为凑数绑定动漫角色。
- 旧快照只有组且描述为单插图时允许单实例兼容兜底；描述明确包含多个画框却无 instances 时必须阻断生成，并提供用户主动的「补充识别局部插图」入口。打开/恢复项目不得自动发起 AI 修复。

## 29. Prompt Confirmation Progressive Disclosure（V5 铁律）

- 确认生成默认摘要固定为：来源、编辑目标、参考图数量与角色、一致性模式、生成模型、尺寸与数量、服务端预计点数。
- 视觉理解/Prompt 优化/评价模型、任务 ID、文件路径、质量参数与完整最终 Prompt 进入默认折叠的「高级详情」；展开/收起是纯视图状态，绝不增加项目修订。
- 预计点数只能来自服务端 quote；取价失败显示「将在提交前按服务端报价确认」，禁止客户端数量乘单价。
- FinalPromptEditor 手动完整 Prompt 必须是 Confirm = Submitted = History 的同一冻结文本；确认或跳转图片工作室不得再次拼接合同或优化。

## 30. System Correction Toast Copy（V5 铁律）

- 普通用户只看到结果：`已保持动漫角色一致` / `已保持人物参考服装` / `已保持锁定内容`；正文说明移除了多少处冲突描述。
- 禁止用户可见标题出现 Guard / Contract / `characterRef` / 「守卫生效」/ 内部字段名。
- 修正 Toast 提供「查看执行过程」动作，进入 Runtime Skill Trace；技术原因与被移除文本留在 Trace，不塞进短 Toast。

## 31. Compact Reference Asset Card（V5 铁律）

- Strict Visual Reference 在 Context Rail 使用一张紧凑「动漫角色参考」卡：待创建时说明创建前报价；已就绪时说明最终生成自动复用、不重复计费。
- 卡片动作只有当前状态需要的一个命令：待创建=`生成角色参考图`，已就绪=`重新生成角色参考图`；重新生成必须强制新报价，普通继续生成命中缓存不得报价或创建任务。
- 角色参考图作为 `anime_character_reference` 排在模板与人物参考之后、其它引用之前；最终 Prompt 明确其为所有动漫区域唯一视觉设计来源。

## 32. Recoverable Blocker Pattern（V6.1 铁律）

- 阻断文案事实源唯一：Validator 与 Rail/页面共用同一纯函数（示例 `detailInsertIncompleteErrors`），UI 只按「可修复 / 其它」分组渲染，禁止出现第二套平行文案。
- 阻断卡结构：标题 + 一句话影响说明 + 主按钮（修复动作）+ 次按钮（查看详情）；修复中显示进行中说明并明示「不会改变你当前的哪些内容」。
- 受限修复（scoped repair）：只合并缺失字段及直接依赖（如 `mergeDetailInsertRepairResults` 只补 `instances`），走 `updateActive` 语义修订；模板九维度、`subjectPoses`、人物替换、锁定维度、用户修改、`originSkill`/`baselineSections` 全部原样保留。
- 失败不清空旧分析：全部失败时返回原快照（同一引用），UI 显示失败 + 重试 + 技术详情默认折叠 `<details>`；成功后显示绿色状态卡（含数量事实）且阻断自动消失，同屏展示实例清单（`#N 位置 · 类型 → 同步对象`）。
- 禁止死路：凡系统内具备修复能力的阻断校验，禁止只给文案不给入口（「请重新分析」「请到 xx 处理」而无按钮 = 返工）。

## 33. Nested Modal / Picker Pattern（V6.1 铁律）

- 二级弹窗（图库选择器、删除确认等）一律 `createPortal(document.body)`：自带 fixed overlay、独立 z-index、自包含 CSS 文件；禁止依赖父弹窗类名或其它页面的 CSS chunk（懒加载 chunk 缺失曾把选择器压成窄长条）。
- Escape 分层：二级弹窗自己的 `window keydown` 只关自己；父弹窗守卫 `galleryOpenRef.current` 时不响应 Escape。backdrop `onMouseDown` target===currentTarget 才关闭，正文点击 `stopPropagation` 防误关。
- 打开二级弹窗时父弹窗正文滚动锁定（`is-picker-open` 条件类）；关闭恢复。
- 层级纪律：业务弹窗 1200 < 二级选择/确认层 1300 < ImageViewer 4000；新增层级先查本表。
- 图片选择网格：`repeat(auto-fill, minmax(140px, 1fr))` 响应式，缩略图统一 `aspect-ratio: 1`、文件名 ellipsis；预览复用全局 ImageViewer（`useImageViewerStore.openViewer`），禁止第二套 viewer。

## 34. Wizard Geometry Pattern（V6.1 铁律）

- 多步骤创作器固定三段式：Header（标题+说明）/ Body（唯一滚动区）/ Footer（状态条+操作行）；弹窗尺寸只随视口（`width: min(960px, calc(100vw - 48px))`、`height: min(720px, calc(100vh - 48px))`），五步共用同一几何。
- 滚动收口：所有 grid 子项 `min-height: 0`，滚动只发生在 Body 与步骤栏；弹窗根 `overflow: hidden`；正文 `overscroll-behavior: contain`。
- 步骤切换禁止改变弹窗几何类（条件类只允许功能性如 `is-picker-open`）；长内容差异靠内部滚动与折叠，不靠改宽高。
- 长详情默认折叠：摘要行 + 【查看完整 X】toggle（`aria-expanded`），如 Recipe 卡「模板复用方案 / Recipe 已冻结 / 模板@原图 / 输入槽位 / 冻结 N 合同块」。
- 响应式断点：≤1100px 步骤栏收窄 160px；≤860px 步骤栏转顶部水平 stepper（`flex-direction: row` + `overflow-x: auto`）。
- 稀疏步骤（如发布确认页）用 content stack 卡片纵向收拢居中，禁止拉大控件填满空间。

## 35. Destructive CRUD Pattern（V6.1 铁律）

- 有创建就有删除：每个 create/edit 界面交付前审计 delete 闭环——stable ID、入口（更多菜单 `⋯`）、danger 二次确认弹窗、确认后才调持久层删除命令（如 `api.deleteUserSkill`）、列表原子过滤、当前编辑态清理（`useDialogDraft?.id === deleteTarget.id` 时关闭）、成功 Toast、空态 + 创建入口 CTA。
- 删除范围文案事实源唯一（纯函数，如 `describeSkillDeleteNotice`）：local 不提示投稿；submitted/under_review/changes_requested/published 或存在投稿记录时，明确「删除本地 Skill 不会撤回已提交的审核记录」；范围行固定列明「删什么 / 不删什么」（历史项目、源图不受影响）。
- 持久层语义：只删本机实体行（`DELETE FROM user_skills`），禁止连带删服务器投稿、公共社区记录、用户图库原图、视觉项目模板源图；删除不存在的 ID 幂等成功。
- busy 期间禁点（取消与确认都 disabled），遮罩点击=取消；确认按钮是唯一 danger 主操作。
- 回归测试要求：纯函数文案 + 前端 wiring guard + Rust 行为测试（只删目标行 / 相邻表不受影响 / 幂等）。

## 36. Progress Honesty Pattern（V6.2 铁律）

- 长耗时 AI 任务的进度模型只含真实事实：阶段枚举（如 准备模板 → AI 识别 → 合并 → 重新校验）+ 真实计数（第 N/M 层）+ 起始时间戳；**进度对象禁止 percent / progress 数字字段**（模型调用没有 token 级进度，禁止伪造 70%）。
- UI 呈现 = indeterminate 动画条 + 「阶段 x/4：文案（第 N/M 层）」+ 每秒重算的「已用时 N 秒」（UI 持有 interval，runner 不持有定时器——执行体保持可测试纯度）。
- 取消 = 层间诚实停止：已完成层照常合并、剩余层不再发起；首层前取消 = 无结果不合并。禁止「假取消」（继续跑完丢弃）与「假完成」（未跑完标成功）。
- 执行体与页面分离：识别逻辑进可复用 runner（如 `detailInsertRepairRunner`），页面/弹窗只做配置解析 + 进度渲染 + 对**最新**状态的纯函数合并；两个消费方（工作台 Rail / Skill 弹窗）共用同一 runner，禁止第二套识别。
- 进度按操作身份隔离：progress 携带 operationId + projectId + projectRevision；运行中切换项目，旧进度不写入新项目（合并回调做 projectId 守卫）。

## 37. Direct Execution Pattern（V6.2 铁律）

- 复用型能力必须提供双执行方式：主按钮「快速生成」（headless 直达结果）+ 次按钮「高级调整」（进完整工作台）；两者同一套 Runtime Registry / Compiler / Validator，**禁止为快速路径建第二套引擎**。
- headless 快速路径零 AI 调用：换素材 = 重编译绑定（确定性），最终描述复用冻结基线；没有让用户审阅优化产物的 UI，就不允许后台偷偷调优化器。
- ephemeral 会话：快速路径不创建持久项目（不写 store、不落库）；项目文档随 carry 进入结果页，banner 提供两条出口——「保存为视觉项目」（adopt 落库）与「进入工作台调整」（先 adopt 再 hydrate）；不保存则零持久化痕迹。
- 执行前 Preflight：与工作台「确认」同一组合法性（合同 / 锁 / 服装 / 一致性 / 实例），阻断卡按「可原位修复（如内嵌 Repair）/ 需工作台」分组；需生成资产的阻断绝不后台代生成——明示走高级调整。
- 计费授权单一入口：自动发起的提交照常走服务端报价 + QuoteConfirmDialog，**autoStart 绝不绕过计费确认**。

## 38. Semantic Reference Label Pattern（V6.2 铁律）

- 参考图角色徽标唯一事实源 = `SEMANTIC_REFERENCE_LABELS`（template=模板图 / person_reference=人物参考 / anime_character_reference=动漫角色参考 / background_reference=背景参考 / style_reference=风格与构图参考 / generic_reference=附加参考）；**禁止「参考图N / 图片N」裸序号命名 UI**（序号只存在于 Prompt 指令块的图片1/2/3 合同语境）。
- 计划参考图（来自视觉方案 / Skill 方案）角色由方案冻结：卡片显示语义徽标 + 🔒，title 提示「改用途请回视觉工作台调整方案」；**计划图不提供 inline 角色下拉**（改角色 = 改方案，必须回方案源头）。
- 手动参考图通过 `⋯` 菜单设置用途：`menuitemradio` + 当前项 ✓ 勾选；菜单单开（一个索引状态管理全部卡片的菜单开合）。
- 摘要行：计划图片清单经 `describeReferenceImagesForUser` 生成「模板图：@xx · 人物参考：@yy」对照行，放在参考图区顶部，把 Raw Prompt 的「图片N」翻译成用户语言。
- carry 链路保真：计划图片以 generationRole + origin:'plan' 进入工作台；mention 层 role（@引用层）与 generationRole（合同层）是两套枚举，映射时必须剥离，禁止混传。

## 39. Auto Save State Pattern（V6.2 铁律）

- 动态工作区（视觉项目等）语义自动保存：debounce（600–1000ms）+ 串行落库（persistInFlight 队列）+ 墓碑删除标记；保存状态四态 = idle / pending / saving / saved / error（含 projectId，跨项目切换不串台）。
- 「已保存」判定必须诚实：保存执行期间又有新编辑（debounce 计时器复活）时，本次完成**不得**标 saved；只有 `persistTimer` 为空（无待存编辑）才显示已自动保存。
- 失败保 dirty：保存失败状态标 error 并保留重试按钮，数据不丢、可手动 `retrySave`；禁止失败后静默丢弃或标成功。
- 切项目冲刷：打开/切换项目前先 `flushPersist()` 在途防抖，防止旧项目最后一步编辑丢失（异步 flush 需 await）。
- 状态指示内联在标题栏 meta 行（自动保存中… / 已自动保存 / 自动保存失败 + 重试），手动保存按钮的 busy = pending || saving。

## 40. Handoff Responsiveness Pattern（V6.2 铁律）

- 确认类交接（如 确认生成 → 另一页面）：同步守卫全部通过后 **100ms 级立即关弹窗**，切换到过渡态（「正在进入图片工作室…」）；重活（外貌解析 / 合同编译 / mask 导出）在过渡态下完成——禁止用 loading 遮罩掩盖真实耗时。
- 预热并行：最重的 IO（视觉模型调用）与同步装配并行发起，等待点后移到装配完成之后（`promise` 先建后 await）。
- 防重入：交接在途用 ref 守卫（双击 / 事件重放直接忽略）；每个交接有唯一 operationId（计时 / 去重共用）。
- 系统修正 Toast 按 operationId + 种类去重（同一操作内 anime_guard / clothing_guard / lock_guard 各只弹一次），防严格模式 / 镜像重放产生重复提示。
- 失败 = toast 回原工作台（弹窗不复活，可再次确认发起）；过渡态文案是状态描述（正在进入…），禁止百分比进度。

## 41. Semantic Feedback Severity Pattern（V6.3 铁律）

- 系统自动修正 Toast 的严重级按**最终用户状态**判定，不按「内部是否跑了 Guard」判定：系统已替用户修正成功、结果就是用户想要的 ⇒ **绿色 success**；只有当被剥离内容确实来自用户当前文字指令（用户明确写了、又被系统移除）才 orange warning。
- 判定唯一入口（`src/features/vision/handoffOperation.ts`）：`contractCorrectionSeverity()`（合同修正恒 success）与 `lockCorrectionSeverity(removedSentences, userInstruction)`（逐句 `removedSentenceFromUserInstruction` 子串匹配，≥4 字符才算用户原话）。**禁止组件按 Guard 类型自猜颜色**。
- 动作统一：severity=success 的修正 Toast 提供「查看执行过程」入口进 Skill Trace（技术原因与被移除原文留在 Trace，不塞进短 Toast）；标题保持用户语言（已保持人物参考服装 / 已保持锁定内容），禁止出现 Guard / Contract / 字段名。
- 去重不变：同一 operationId + 种类（anime_guard / clothing_guard / lock_guard）只弹一次；severity 判定不影响去重逻辑。

## 42. Direct Preflight Status Pattern（V6.3 铁律）

- 快速生成（Direct Mode）的前置检查用**四态状态卡**呈现，禁止弱化成一行小字：
  - `ready`（绿）：「可以快速生成」+ 就绪清单；
  - `repairable`（橙）：「快速生成还差 1 步」+ 主按钮「立即处理」（内嵌修复，如缺失层补充识别）；
  - `needs_input`（业务输入，非错误）：缺人物参考 / 服装文本等用户决定项，提供选择入口；
  - `blocked`：本 Skill 的形态必须走完整工作台（如动漫角色一致性需资产生成），说明原因 + 「高级调整」出口。
- 分类唯一入口 `classifySkillDirectPreflight(blockers)`（`src/features/skillWorkshop/skillDirectExecution.ts`）：软集（`needs_input` / `clothing` / `detail_insert_incomplete`）→ needs_input；其余 → blocked；空 → ready。UI 只渲染，不重判。
- 需要人物参考的 Skill（`skillPersonSlotRequired(recipe)`）未绑定人物 ⇒ needs_input 卡明确文案「需要一张人物参考图」，不得放行为 blocked 泛化文案，也不得静默无人物执行。
- Preflight 与工作台「确认」共享同一套 Validator / Blocker 语义（Direct Execution Pattern §37 的延伸）；四态卡是同一合法性的**展示层**，禁止第二套校验。

## 43. Modification Slot Fidelity Pattern（V6.3 铁律）

- Skill 输入槽位**由修改合同派生**，不是 UI 写死的 person-only 清单：`deriveSkillInputSlots(recipe)` 读 `modificationTemplate {personEnabled, clothingPolicy, customClothing}`——
  - 人物 + `use_subject_reference` ⇒ 一个 **combined 必选槽**（usage `identity_clothing`，徽标 身份+服装，说明「这张图片将同时提供人物身份与服装；姿势、构图、背景不会从该图继承」）；
  - 人物 + `preserve_original` ⇒ 独立身份槽（可选，说明「服装沿用模板」）；
  - `custom` ⇒ 服装要求**文本槽**（defaultText = 保存值）；`preserve_template` 不产生任何槽（模板槽除外）。
- 存储的 slots 字段不再被信任：载入一律按 modificationTemplate 重派生（旧 Recipe 无 modificationTemplate ⇒ 回落 personEnabled + preserve_original，零迁移）；重建项目（`buildProjectFromSkillRecipe`）必须应用保存的服装策略，不得退回保留模板。
- **换槽位绑定 = 重绑 facts + 确定性重编译**：锁定维度漂移值回模板基线（`resetDriftedPlanFieldsToTemplateBaseline`）+ 重建执行态整体复位（editState ready、semanticRevision/optimizedRevision 归零、adjustInstruction 清空、optimizedPrompt=originalPrompt、优化历史丢弃）——实例专属优化 delta 不进入新会话。
- 铁律：除非用户**新增语义指令**，直接生成链路绝不出现 `needsOptimization=true`、绝不建议「重新优化 Prompt」；没有让用户审阅优化产物的 UI，就不允许后台偷偷调优化器（§37 headless 纪律的槽位版）。

## 44. Compact Subject Replacement Pattern（V6.3 铁律）

- 人物替换面板信息架构 = 四个语义分组（各一行一组，`PERSON_REPLACEMENT.group*` 唯一文案源）：**主体**（模板图→人物参考映射）/ **来源**（身份来源 + 服装来源并列同组）/ **执行范围**（替换范围 + 身份应用）/ **替换强度**。
- 映射卡紧凑横排：缩略图 120–160px（`.vision-person-map-thumb` 150px 定宽、图 max-height 140px）+ 右侧信息；卡片只做**识别**，看大图点击进全局 ImageViewer（`useImageViewerStore`，cursor zoom-in）——禁止在业务卡里放大图。
- 动作词指向参考图而非结果：按钮文案「**更换人物参考**」（不是「更换人物」）；来源下拉标签「**身份来源**」（与「服装来源」并列，避免「人物来源」与服装通道混淆）。
- 紧凑化不得丢可达性：空态纵向居中、radiogroup/radio/aria-checked、二选一选择流（`picking || !hasImageRef`）全部保留；合同控件（替换范围 / applyIdentityTo / 强度）只是换了分组容器，不改语义。

## 45. Entity Cover Pattern（V6.3 铁律）

- 实体封面（如 Skill Cover）是 **display-only 元数据**（`UserSkill.cover {source, path?, assetId?}`），经 Rust `data_json` JSON 透传持久化（无结构迁移、无 Rust 改动）；载入合法化（`normalizeSkillCover`）拒绝坏数据，不伪造封面。
- 解析优先级唯一入口 `resolveSkillCoverPath(cover, {samplePath, templatePath})`：**用户自定义 ＞ 公开生成样例 ＞ 模板图 ＞ 类型图标 fallback**；损坏的自定义路径沿链兜底（不显示破图）。样例候选 `skillCoverSamplePath`：publicCover ＞ selectedForSubmission ＞ 任一样例。
- 选择器复用唯一 `ImageLibraryPicker`（禁止第二套图片选择器）；每个消费界面至多一个 picker 实例（弹窗内双用途时用 `galleryOpenRef = a || b` 合并 Escape 守卫）。
- 边界铁律：封面（含图库本地路径）**绝不进入投稿载荷**（`sanitizeUserSkillForSubmission` 剥离）；换封面 Toast 明示「仅本机展示，不影响模板、生成方案与已提交的审核记录」；删除实体**只删实体行，不删图库文件**（封面是引用，没有文件所有权）。

## 46. Gallery Folders & Staged Modification Pattern（V6.6 铁律）

- **文件夹是物理目录**：新建走 Rust `create_image_folder`（名字清洗 + 重名 `(2)` 去重 + `create_dir_all`），注册表只记 id/name/path；`sync_images` 扫描根并入注册表路径。归属判定唯一入口 `matchesGalleryFolder`（与 Rust `normalize_image_path_key` 同归一化规则：分隔符统一 + Windows 盘符小写）。
- **输出位置选择器全库唯一**：`OutputPathPicker`（默认路径 / 图库文件夹 / 浏览 / 自定义兜底显示）——当前值不在选项中时显示「自定义：目录名」，不伪造归属；未选文件夹 = 默认路径（`default_output_dir` 预填语义保持）。
- **四步向导（V6.7）**：左侧步骤栏（视图理解 / 需求描述 / 素材替换 / 最终提示词；完成 ✓ success、当前 accent-light、未解锁降透明禁用）+ 当前步骤内容；门禁纯函数 `visionStepReachable`（第 3 步必须先描述），自动前进（理解就绪→2、优化成功→2 进 3 / 3 进 4）；空步骤显示引导空态，不显示空白区域；状态栏与操作行是第 2-4 步共用脚注。
- **已启用卡边框一致**：三面板统一 `border: 1px solid var(--accent-primary); box-shadow: 0 0 0 1px var(--accent-primary-light);`——启用状态的一致视觉信号由「已启用」badge + 边框共同承担，禁止单卡独享。
