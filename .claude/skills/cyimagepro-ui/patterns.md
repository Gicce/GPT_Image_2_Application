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
- 扣费标准弹窗：单张 N 点（约 ¥X）+ 费目明细（每笔 M 点）；旧 `$` 口径仅历史数据回退显示。
