# Visual Workflow（视觉理解复刻工作流 UI Pattern，V4.1）

> 实例：`src/pages/VisionUnderstanding.tsx`（理解 → 修改 → 优化 → 审 Prompt → 生成 → 评价 → 反馈 → 迭代）。
> 状态机 / 守卫 / 文案唯一来源：`src/features/vision/recreationPlan.ts` + `recreationCopy.ts`。
> 视觉模型结构化响应容错与错误呈现契约见 §0（V4.0.9）。

## 0. Vision Response Tolerance & Error Presentation（V4.0.9 强制契约）

背景：GLM-5V-Turbo 等视觉模型的结构化输出存在合理类型漂移（string 字段返回 array / object / null），曾以 `invalid type: sequence, expected a string` 直接炸掉整次理解。修复架构（Rust `vision_normalize.rs`）：

```text
模型响应 → Transport（content string/parts 双形态统一提取）
→ JSON 提取 → 规范化（schema 驱动 string-like / 数组语义 / 数字 / 布尔 / 区域归一）
→ 严格反序列化（Canonical VisionAnalysis 保持严格类型）
→ 仍失败 → 同一模型最多一次结构修复（不切换模型路由）→ 才进入用户可见失败
```

UI 侧强制规则（`src/features/vision/visionErrors.ts` 唯一映射层）：

1. **Internal transport / parser / schema errors MUST NEVER be exposed directly in user-facing UI.** `invalid type` / `sequence` / `serde` / `JSON parse` / `schema` 等词只允许出现在开发日志（`[VisionSchema]` 前缀，含 field path / actual type / action / repair 轨迹）。
2. **Hiding an error message is NOT error recovery.** 恢复（normalize → validate → 最多一次 repair）在 Rust 层完成；`mapVisionErrorToUserMessage` 只是最后一道防线：按 `error_kind` 映射 + `isTechnicalErrorMessage` 拦截，禁止裸渲染 `error_message`。
3. **失败保留旧成功**：重新理解失败绝不清空 `analysis` / `recreation` / Prompt（store `markStage('failed')` 只落 stage + errorText）；有旧结果时文案前缀「本次重新理解没有完成，仍保留上一次分析结果。」失败后入口按钮立即可用（busy 只看 analyzing/running）。
4. **修复过程用户无感**：repair 在同一次 `visionAnalyzeImage` 调用内完成，UI 停留在 `analyzing` 的 VisualAnalysisProgress；禁止出现「正在修复 JSON / 重新解析 Schema」类文案。
5. schema 漂移属于响应规范化问题（`schema_error`），不是模型不可用：**绝不因结构漂移触发模型 fallback**；修复也使用当前 `vision_analysis` 路由的同一模型。
6. normalization / repair 属于基础设施状态，**不得触碰 `semanticRevision`**（UI state / infrastructure state ≠ semantic state，见 §1e）。



## 1. 工作流全链

```text
上传 / 选择参考图
→ AI 理解（VisualAnalysisProgress：参考图缩略图 + 创意文案轮播 + 扫描反馈；summary 常驻，详细折叠）
→ 选择修改维度（ModificationChip 结构化选择器）+ 自由文本（可 @引用当前任务图片）+ 人物替换 + 服装策略
→ 优化复刻 Prompt（role=vision_prompt_optimizer：默认跟随视觉理解模型；AI 返回 changed_dimensions = 结构化修改意图；
  优化器模型具备视觉能力时图片引用（画面模板图 + 人物替换图 + @引用图）以真实 image_url 进入 multimodal payload）
→ 立即看到：最终生图 Prompt + 本轮修改 Diff（头部 Provenance：由 {模型} 优化 · HH:MM）
→ 确认生成（守卫按 semanticRevision 拦截未优化修改；提交 = 显示值；弹层列出四行模型快照）
→ 生成图片（ResultGallery 缩略图，无页面内重复大图）
→ 缩略图下方立即看到：复刻完成度 + 指标 + 👍/👎 + ♡
→ 继续调整（反馈回填自由文本，只填充不自动触发）
```

## 1a. Visual Analysis Loading Pattern（分析阶段产品化反馈，V4.1）

实例：`src/features/vision/VisualAnalysisProgress.tsx` + `recreationCopy.ts#ANALYSIS_PROGRESS`。规则：

1. **只在真实 `analyzing` 阶段渲染**：文案轮播发生在同一真实视觉分析阶段内（`getVisualAnalysisMessage(index)` 确定性取模，非随机）；禁止伪造 upload/parse 子阶段或「75%」类伪精确进度；高复刻循环各阶段仍用通用 stage bar。
2. **绑定当前参考图缩略图**（本地重读，不生成装饰图）；动效限轻量扫描线 + 呼吸边框（品牌色 color-mix，禁止霓虹 / Cyan / 粒子）。
3. **prefers-reduced-motion**：关闭扫描与轮播动画，保留静态状态（副标题 + 模型名仍展示）。
4. **失败即停**：失败由 errorText 卡片呈现经 `mapVisionErrorToUserMessage` 映射后的产品级文案（含内部结构修复重试时也停留在此阶段，用户无感，见 §0）；组件随 analyzing 结束卸载，轮播 interval 在 effect cleanup 中清除，绝不出现失败后文案继续滚。
5. 固定结构：缩略图（84px 呼吸描边）+ 主文案（轮播）+ 副标题（正在识别人物、动作、构图与风格）+ 模型标签。

## 1b. Modification Dimension Selector（快捷修改维度选择器，V4.1）

实例：`src/features/vision/ModificationChips.tsx` + `modificationIntent.ts`。规则：

1. **快捷按钮是结构化选择器，不是 textarea 文本追加**：状态唯一来源 = workspace `modificationDraft.activeDimensions`；禁止 `textarea.includes()` 反推选中态，禁止 append「修改风格：」协议。
2. **同一维度唯一槽位**：再次点击 = 取消并删除该维度结构化意图（连点 N 次永不产生重复槽位）；不同维度可同时激活（人物 + 动作 + 背景 + 风格）。
3. **「提高复刻度」不是视觉维度**：独立 `replicationBoost` 开关（preservation strength），虚线边框 Chip 区分。
4. 选中态：`✓ 前缀 + aria-pressed + Brand Soft`（`--accent-primary-light` 底 + 主色描边 + 主色文字）；未选 = 普通 Chip；与 Primary CTA 不同强度。键盘可用 + focus-visible 描边。
5. 维度定义单一来源 `MODIFICATION_CHIP_DEFS`（subject/pose/scene/camera/style/clothing），映射到 `RecreationFieldKey`；**禁止另建冲突 enum**。

## 1c. Person Replacement Pattern（人物替换业务卡，V4.0.9）

实例：`src/features/vision/PersonReplacementPanel.tsx`。挂在「修改人物」维度激活时展开。**Person Replacement is a first-class business action, not a weak advanced form section**：主色描边业务卡（`.vision-person-panel.is-business`）+ 👤 卡头（「人物替换」+ `已启用` 徽章 + 一句业务说明 + 移除按钮）。规则：

1. **双区结构**：A 区「画面模板」（当前任务主参考图；缩略图 + 「当前使用：@原图」+ `更换模板图`，更换 = 更换工作区参考图会重置分析，按钮 tooltip 必须说明）；B 区「替换人物」（三种来源 tab）。两区用途文案固定：模板 = 继承画风 / 构图 / 背景 / 整体氛围；人物 = 替换主角身份 / 五官 / 发型 / 人物特征。
2. **三种人物来源**（tab 语义，role=tablist）：图片库人物（复用图库弹层，无可靠人物分类时不假装智能过滤）/ 本地导入（文件选择）/ 文字描述（textarea）。来源 Tab 切换是视图操作；真正落语义的是人物数据（参考图 / 非空描述）。
3. 人物参考图语义 = 身份 / 脸部 / 发型 / 体型；是否采用其服装由 ClothingPolicy 决定，禁止偷偷跟随。
4. 缩略图点击进全局 ImageViewer（禁止再造 Preview Modal）；「更换人物」「移除人物替换」为 secondary 按钮。**（V4.1）预览用真实大图不用小裁切缩略图**：`usePersonThumb` 两级加载（缓存缩略图秒开 → readImageData 原图替换，原图失败保留缩略图）；预览容器 `object-fit: contain` 按原始比例完整呈现（禁止固定 4:3 + cover 裁切——人物图必须能看清脸 / 发型 / 服装 / 姿势），max-height ~260px，点击仍进 ImageViewer 放大。
5. **移除人物替换**：删 person 数据 + 解除 subject 维度 + 仅因人物产生的服装自定义回默认；不触碰其它维度与自由文本、不删 @mention 文本。
6. 人物参考图（i2i）经 GenerationCarry.personReferencePath 作为第二张参考图带入图片工作室。
7. **（V4.1）「当前规则」摘要动态派生**：`buildReplacementSummary` 除替换 / 服装 / 保留行外，按 `activeDimensions` 增补「修改」行（动作 →「因已启用『修改动作』，将在原图基础上生成新的动作变化」等）；已启用修改的维度从「保留」行剔除（启用 = 必须改，不再标保留）。

## 1g. Image Mention（@图片引用，V4.0.9 强制契约）

实例：`src/features/vision/IntentMentionInput.tsx` + 纯函数层 `imageMention.ts`。规则：

1. **In Vision Workflow, @image mentions MUST resolve from current task/conversation images first.** 弹层候选唯一来源 = `buildVisionContextImages`（主参考图 + 人物替换参考 + 图库附加参考 + 本任务生成结果；按当前任务隔离，绝不出现其它对话图片）；末条固定「＋ 从图片库选择…」把图加入当前任务再引用。
2. **Mention 是真实图片引用，不是纯文本补全**：freeText 中的 `@token` 是持久化安全的普通文本，真实绑定在 `draft.mentions` 侧车表（assetId / path / role）；孤儿绑定（文本已删 token）由 `pruneMentions` 清理，绝不残留幽灵引用。
3. **输入框是原生 textarea**（IME / 中文输入法安全，禁止为 @ 强上富文本编辑器 / contentEditable）；@token 的可视化用背景高亮层（`.vision-mention-backdrop` 与 textarea 同 padding / 字体 / 行高 / 换行，pill 无额外 padding 保证对齐）。**度量对齐铁律（V4.1 修文本重叠）**：textarea 必须显式 `font-family: inherit`（UA 默认 Arial 系与页面字体中文字宽不同 → 逐行漂移重叠）；token pill 禁止 `font-weight` / `padding`（与 textarea 同文本字重必须一致）；换行属性只用 `white-space: pre-wrap; overflow-wrap: break-word`（不加 `word-break`）；token 上限 16 字符 + 省略号（`mentionTokenOf`，超长文件名不压坏输入区，完整名在 chip title / hover）。引用 chips 行提供 hover 看图（缩略图）、点击进全局 ImageViewer、× 移除；chip 显示 `@{label}`（完整名 title），不是内部 token。
4. **弹层是纯视图操作**：开关 / ↑↓ / Esc / hover 不写任何 store、不触发 semanticRevision（组件内禁止 import useVisionWorkspaceStore）；只有真实插入 / 删除 mention 才经 onChange / onMentionsChange 上抛语义。IME 组合态（isComposing）不处理弹层键盘。
5. **When a task involves "replace the person in image A with the person from image B", the system must preserve the semantic roles of both images**: A = template/style/composition reference；B = person replacement reference。解析唯一入口 `resolveImageMentionRoles`（优先级：用户显式面板选择 > 明确 Mention 语义 > 普通自由文本猜测）；自然语言序号（图二 / 图3 / 第二张）按「图N」文件名标签 + 池序号匹配。
6. 解析出人物来源而面板为空时显示「已识别图片角色」建议条（`应用到人物替换` 走正常语义通道）；**绝不偷偷覆盖用户已手动设置的卡片值**；忽略态是视图（签名变化可再出现）。
7. 优化器 payload：`collectOptimizerImageReferences` 汇总（模板 → 人物 → 其它，路径去重），`buildImageReferencesBlock` 生成清单文本块，parts 顺序与清单一一对应（读取失败的图不进清单不占序号）。

## 1d. Clothing Policy（服装处理，V4.0.9 模板图口径；V4.0.9.1 状态不变量）

**状态模型铁律：`clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'`（「修改服装」与「严格保留原图（画面模板）服装」是矛盾语义，任何有效状态不得同时成立）。**

1. `ClothingPolicy = 'preserve_original' | 'use_subject_reference' | 'custom'` 严格单选（radiogroup + checked 样式，不只靠颜色）。
2. 默认推荐「沿用模板图服装」：用户只说「换一个人」→ subject 修改、clothing 锁定画面模板（原图）；副文案必须说清「只替换人物身份，继续沿用模板图（原图）中的服装与造型」。
3. `use_subject_reference` 仅在有图片参考时提供（副文案「人物与服装都以人物参考图为准」）；`custom` 附「描述新的服装 / 造型」输入。
4. 「服装 / 造型」（clothing）是独立复刻维度（第九维）：只改服装时 subject 保持锁定；人物描述含服装（「黑发男性，穿白色西装」）→ AI 判 subject + clothing 双修改（优化器系统提示词规则 5/6）。
5. 合成指令必须显式写出服装保留 / 替换约束（`clothingPolicyInstruction`，口径「严格保留原图（画面模板）服装」），禁止只给模型一句「换这个人」。
6. **（V4.0.9.1 不变量落地）唯一归一入口 `normalizeModificationState`（modificationIntent.ts）**：所有写入路径（`toggleModificationDimension` / `setClothingPolicy` / `clearPersonReplacement` / 持久化恢复 `migrateModificationDraft` / workspace store `setModificationDraft` 最终收口）都经过它，绝不把矛盾态留给 Prompt 编译器或优化器。
   - 用户在 `preserve_original` 下点击「修改服装」Chip → 自动切换 `use_subject_reference`（有人物参考图，推荐默认）或 `custom`（无参考图，等用户补描述，不伪造内容）；再次点击 Chip 取消 → 回到 `preserve_original`。
   - 用户选「原图服装」→ `activeDimensions.remove('clothing')`（Chip 取消高亮）；选「人物服装 / 自定义」→ `clothing` 维度自动 ON。
   - `custom` 且描述为空 → `clothingReadinessError` 拦截优化与生成（「请描述新的服装 / 造型。」）。
   - 移除人物替换时显式启用过的服装修改保留（策略降级 `custom`），不静默丢失用户意图。
   - 优化器系统提示词规则 6 硬性对应：`preserve_original` → clothing 绝不进 changed_dimensions；`use_subject_reference` / `custom` → clothing 必须进 changed_dimensions 且值来自对应来源。
   - 「维度锁定（锁定 X · 可修改 Y）」计数以 `activeDimensions` 为单一事实源：Chip 已启用的维度即使尚未优化也计入「可修改」。

## 1h. Generation Provenance Snapshot（生成溯源快照，V4.0.9.1）

实例：`src/features/vision/generationProvenance.ts`（构建器 + 展示模型）；类型契约 `src/types/index.ts#GenerationProvenanceSnapshot`；Rust 侧 `Task.provenance`（JSON 透传，schema 由前端单一维护）。规则：

1. **User instruction, structured modification plan, and final execution prompt are three distinct provenance layers and MUST NOT be conflated.** 快照冻结 `userInstruction`（用户原话，@token 展示层解析为 @label，底层保留 `userInstructionRaw` + `mentionBindings`）、`modificationIntent`（activeDimensions / changedDimensions / personReplacement / clothingPolicy）、`imageRoles`（template / person_reference / background_reference / style_reference / generic_reference，assetId+path+label）与 `models`（视觉理解 / Prompt 优化 / 图片生成 / AI 评价，全部来自生成时刻 resolve，不读当前 Settings）。最终 Prompt 不复制进快照（Task.final_prompt 即真实提交快照）。
2. **构建与冻结链**：`generateFromPlan` → `buildGenerationProvenance` → `buildGenerationCarry().provenance` → `VisionCarryDraft.provenance` → ImageStudio 提交 `CreateTaskParams.provenance` → Rust `create_task` 透传落库；`task_source='vision_recreation'`（与生成方式「图生图」是两个维度，可并存）。
3. **历史详情四层结构（History）**：② 用户要求（只读快照 `userInstruction`；旧视觉任务无快照 → 明示「该历史任务未保存原始用户要求」，禁止用 final_prompt / optimizedPrompt 伪造；普通任务读 `user_prompt_raw`）→ ③ 本次修改方案（`describeProvenanceModificationPlan` 结构化行，旧任务不凭 Prompt 反推）→ ④ 参考图片（快照任务按角色显示「画面模板 / 人物参考…」；旧任务只显示「参考图 N」不瞎猜角色；点击进全局 ImageViewer）→ ⑤ 最终执行 Prompt（Task.final_prompt 快照 + 复制；复刻原始 Prompt 折叠）→ ⑥ 模型执行记录（生成时快照）。
4. 小节序号按渲染顺序取号（① 概览 ② 用户要求 起步），条件区块不跳号。

## 1e. View State vs Semantic State（视图与语义分离铁律，V4.1）

```text
View State（useVisionViewStore，进程内、不持久化）   Semantic State（useVisionWorkspaceStore）
dimensionsCollapsed / advancedCollapsed /            modificationDraft（freeText / activeDimensions /
analysisDetailCollapsed / promptView('final'|'diff') person / clothingPolicy / customClothing /
ImageViewer open / 选中缩略图 / hover / popover        replicationBoost）、recreation（修订 + Prompt 产物）
```

1. **Collapse / Expand / Tab / Viewer / Selection-only actions are view state. They MUST NOT change semantic revision or Prompt provenance.**
2. 禁止把折叠 / Tab 字段塞进 RecreationPlan / Prompt Provenance / GenerationCarry；禁止页面本地声明业务折叠态（统一走 view store）。

## 1f. Semantic Revision（语义修订模型，V4.1）

1. `recreation.semanticRevision` / `optimizedRevision`：只有真实语义修改（自由文本 / 维度 toggle / 人物 / 服装 / 锁定项 / 原始 Prompt / 参考资产）才 +1。
2. 优化成功 `applyOptimizationResult` → `optimizedRevision = semanticRevision`；从已对齐状态发起「重新优化」= 新的待消化尝试（markOptimizing 补 +1，失败保持领先）。
3. **needsOptimization = semanticRevision !== optimizedRevision**（唯一派生判定，取代旧粘滞 `modified` 标记）；生图守卫 `canGenerateFromRecreation` 只认它。
4. 合成修改意图为空且无待消化修改 → 维持现状（优化产物仍有效）；有待消化修改 → 对齐 revision（等价放弃未优化修改）。**绝不出现空指令卡死在 dirty。**
5. 手动编辑最终 Prompt（promptDraft）不触碰 revision：`Prompt 已手动修改，可直接生成，也可重新优化`（manual 状态徽章独立于 semantic intent）。

## 2. Prompt Provenance（最终 Prompt 唯一性）

- **Final Prompt 是唯一 Prompt Editor**：页面存在唯一概念「最终生图 Prompt」=「确认生成图片」实际提交值；**显示值 === 提交值**（同一来源 `promptDraft`），禁止页面显示 A、后台提交 B。
- **禁止 Final Prompt + Edit Generation Plan（「编辑生成方案」）两个编辑区同时存在**：旧折叠式第二套 Prompt textarea 已删除；同一 Prompt 在页面只允许出现一次。
- FinalPromptEditor 两种显示状态（同一块空间切换）：
  - **Final View（最终版本，默认）**：干净 Prompt 全文 + 可直接编辑（textarea 绑定 promptDraft，单一 onChange 入口）+ 「复制 Prompt」；
  - **Diff View（修改对比）**：原始复刻 Prompt → 最终生图 Prompt 的 token 级 Diff（新增绿 / 删除红 + 删除线 / 未变化普通色），**不是另一个 Prompt 输入框**；未变化时 Tab 禁用。
- 状态四态徽章：`最终 Prompt 已生成`（绿）/ `Prompt 已手动修改，可直接生成，也可重新优化`（蓝，manual）/ `修改已记录，最终 Prompt 待重新生成`（琥珀）/ `本次优化失败`（红，有上一次成功时附「仍可使用上一次成功的 Prompt」）。
- **失败不清空成功结果**：第 1 次成功后第 2 次失败 → 第 1 次产物原样保留（状态机保证）；提供「使用上一次 Prompt」回退（Banner 外 CTA，非 Primary）。
- **（V4.1）优化模型可见性**：「优化复刻 Prompt」按钮旁常驻 `Prompt 优化 · {模型} · 跟随视觉理解 / 单独指定 / 当前回退` 轻量标签（点击前可见，与实际请求同一次 resolve）；优化中按钮文案 `正在优化… · {模型}`；follow 解析失败显示回退原因 warn hint，优化成功发生 fallback 时 Toast「已回退优化模型」。头部 Provenance：`由 {模型} 优化 · HH:MM`。模型路由唯一规范见 ai-model-routing.md（Displayed model MUST equal resolved runtime model）。

## 3. Dimension Lock（维度锁定三来源，优先级强制）

```text
User Override（用户手动切换） > Modification Intent（AI 按意图判定） > Default Preservation（默认保留）
```

- `lockSource`: `user_override`（硬约束，重新优化不得覆盖）/ `intent`（本轮 AI 判定）/ `default`（软约束，AI 可按意图打开）。
- 修改意图来自优化器输出的 `changed_dimensions` / `dimension_values`（结构化，九维含 clothing），**禁止前端 includes() 猜维度**。
- 维度卡角标四态：`锁定` / `可修改` / `已修改`（值变化且未锁定，success soft 色）+ `·手动` 后缀（user_override 标识）。
- 模糊意图（如「更梦幻」）只开放 style/lighting/color 类贴切维度，禁止大面积解锁。
- 自由文本与快捷维度共存：优化器输入 = `buildModificationInstruction` 合成指令（freeText + 重点修改维度 + 逐维度 must-change 指令 + 人物替换 + 服装处理 + 复刻强度）；AI Intent Recognition 仍独立判定 freeText 中提到的维度，快捷按钮只是帮助表达，两种信息都不能丢。
- **（V4.1 铁律）启用 = 必须真实修改**：快捷 Chip 启用的维度经三层强制进入优化器与最终 Prompt——① 合成指令输出逐维度 must-change 行（`dimensionDirectiveInstruction`：动作 →「必须生成与原图明确不同的新动作…禁止沿用原图姿势」，未给具体值也绝不退化成保持原样；背景 →「背景内容不再照搬原图…保持画面风格与动漫氛围」）；② `optimizeVisionRecreation` 携带 `forcedDimensions`，`buildVisionRecreationUserContent` 把对应方案行标为「用户显式要求修改（必须真实修改并列入 changed_dimensions）」；③ 系统提示词规则 2a：显式启用维度不受规则 2「禁止大面积放开」约束。`user_override` 手动锁定仍最高优先（锁定项不受 forcedDimensions 影响）。人物替换启用时模板行写「已启用的修改维度（动作、背景…）按各自修改指令执行」，绝不写死「其余视觉结构尽量沿用模板图」。

## 4. Prompt Diff（修改对比）

- **（V4.1）先摘要、后全文**：FinalPromptEditor 顶部常驻「本次重点修改」结构化摘要（`buildPromptChangeSummary` 纯函数：从 adjustInstruction 指令行 + 优化后维度 Diff 派生，按 人物 / 动作 / 背景 / 服装 / 镜头 / 风格 分组，每项带 `待优化`（planned）/ `已修改`（applied）状态徽章；画面模板 / 复刻强度进上下文行）；Diff Tab 底部附「本次关键变化」同源摘要。禁止只剩全文机械 diff 噪音；摘要条目一句话截断（全文在编辑 / Diff Tab 看）。
- 默认展示**维度 Diff**（维度卡内：`-原：旧值` 红删除线 / `+新：新值` 绿新增）；只对 changed 维度显示，锁定维度显示原值；**服装锁定时不得伪造 changed diff**（人物/服装各自按 AI changed_dimensions 判定）。
- 全文 Diff 在 FinalPromptEditor 的「修改对比」Tab（原始复刻 Prompt → 最终生图 Prompt）。
- 可访问性三通道：颜色（`--diff-*` Token）+ `+/-` 前缀 + 删除线；不只靠颜色。
- diff 实现唯一来源：`src/features/vision/promptDiff.ts`（CJK 逐字 / 拉丁按词 / 标点稳定的 LCS diff；禁止整段判成删除+新增）。
- **维度 Diff 与全文 Diff 职责分离**：DimensionCard 回答「哪个维度改了」；FinalPromptEditor Diff 回答「最终 Prompt 整体增删了什么」；不得出现第三份 Prompt 展示。

## 5. WorkflowStatusBanner（状态横幅）

- 结构：状态点（tone 同色圆点）+ 标签（加粗）+ 引导语；tone = gray/green/orange/blue/red。
- CTA（如「使用上一次 Prompt」）放 Banner **外**同一行，不塞进 Banner。
- 高度 / padding / 圆角统一；Dark/Light 均清晰（badge-* Token 主题化）。

## 6. 生成结果区（ResultGallery + AI 评价，无页面内重复大图）

```text
生成结果卡
├─ head（任务号 + 生成中/失败 + 最高 N）
├─ ResultGallery：原图（进 Viewer）+ 生成缩略图
│   （选中主色描边 / 评分徽章 / 收藏 ♥ 角标 / hover：查看 + 收藏；
│     点击缩略图 = 选中 + 进入全局 ImageViewer）
└─ EvaluationPanel（跟随当前选中缩略图，全宽置于缩略图网格下方）
   （复刻完成度 + 六维 + 摘要 + 👍/👎 + 下一轮建议 + 继续调整）
```

- **页面内不渲染 SelectedResult 大图**：查看大图统一进全局 ImageViewer（携带该张实际提交的 Prompt）；选中态只体现在缩略图描边与评价联动。
- 评价紧邻缩略图网格（其下方），禁止沉到页面底部；评价长文本默认 2~4 行 + 「查看完整评价」。
- 反馈语义分离：`👍 满意 / 👎 需要调整` = 对本次生成的反馈（user_rating）；`♡/♥ 收藏` = 精选标记（image_evaluations.favorite）；三者禁止混用。
- 反馈按钮是 Toggle Action（secondary 样式），不是 Primary Button；Primary 永远是流程动作（确认生成图片 / 优化复刻 Prompt / 继续调整）。
- 评分语义一致：Gallery 顶部「最高 98」/ 缩略图徽章「98」/ 详情「复刻完成度 98」。


## 7. Visual Project Pattern（项目化工作台，V4.1 Workbench V2）

实例：`src/features/vision/project/`（types / project / personContract / rendering / region / template / validators / effectivePlan / promptCompiler / optimizerContract / migrate）+ `src/store/useVisualProjectStore.ts` + `src/features/vision/project/{ProjectHeaderBar,ContextRail}.tsx` + `src/features/vision/region/{RegionEditorPanel,RegionCanvasEditor,regionMask}.*`。规则：

1. **Template = baseline，Modification = overlay**：`VisualTemplateSnapshot` 在分析成功时刻冻结（九维度 originalValue + mediaStructure）；用户改人物 / 背景绝不写回模板维度；重新分析才重建（`reapplyTemplateFromAnalysis`，换图先弹「保留修改意图 / 重新开始」确认，§5）。
2. **项目语义修订白名单**：`updateActive(reason, mutate)` / `updateActiveDebounced`（文本连击合并为一次修订，`flushPendingSemantic` 冲刷）；reason ∈ modification/person/dimensions/clothing/regions/references/rendering_contract/template/free_text/generation_result。`updateActiveMeta`（重命名 / 状态推进 / lastOpenedAt）不加修订。折叠 / Tab / Viewer / hover / 项目卡展开绝不经这些入口。
3. **恢复绝不重分析**：项目文档整体 JSON 存 Rust `visual_projects` 表（schema 由 TS 维护，data_json 透传，同 provenance 模式）；`openProject` = load + normalize + `hydrateWorkspaceFromActive`；legacy workspace 有分析结果时自动迁移为「未命名视觉项目」（§36，缺模板按 recreation originalValue 重建，绝不调 API）。
4. **复制 / 派生**：duplicate 全量复制（生成历史与 revision 归零）；derive 保留模板 / 媒介 / 风格 / 构图 / 镜头，重置人物参考与修改意图。
5. **Effective Plan 唯一合成视图**：Rail「当前方案」/ 确认弹层 / Prompt Compiler / 溯源快照全读 `buildEffectiveVisualPlan(project)`（rows: person_identity/person_strength/person_scope/template_identity/维度/媒介/区域/复刻强度 + blockingErrors）；组件自行拼合同行 = 违规。
6. **生成硬门禁（§38）**：只有语义错误阻断（strict 无参考图 / custom 服装空描述 / custom_region 区域缺失或停用 / 模板缺失）；视图状态绝不参与（`validateGenerationContract`）。

## 8. Identity vs RenderingMode（媒介结构契约，V4.1）

实例：`src/features/vision/project/rendering.ts`（deriveRenderingContract / applyStyleDirection / applyUniformRenderingMode / validateRenderingContract）+ `promptCompiler.ts#compileRenderingContract`。规则：

1. 分析新协议可选返回 `media_structure`（overall_mode + regions[].rendering_mode/identity_relation）；缺失时从 style 关键词确定性推断（纯照片→photorealistic、纯动漫→anime_illustration；插画词在动漫已命中时不重复计数），绝不强行判混合。
2. 混合媒介合同必须逐层声明「是谁 × 怎么画」；`禁止整图统一成单一媒介` 是编译进 Prompt 的显式指令——这是「真人+动漫模板最终整图动漫化」缺陷的正式修复。
3. `applyStyleDirection` 是恒等函数（契约不可变；风格方向由 Compiler 叠加在层描述上）；唯一允许改写渲染模式的入口是用户显式 `applyUniformRenderingMode`。
4. 编译层文案锚点：`【媒介结构合同（混合媒介，强制执行）】` + 各层 `媒介层N（label，role）：以X方式呈现；身份：…` + `与主体人物为同一人物`。

## 9. Region Editing Contract（区域替换 V1，V4.1）

实例：`src/features/vision/region/`（RegionEditorPanel / RegionCanvasEditor / regionMask）+ `project/region.ts`。规则：

1. 坐标归一化 0..1（`normalizeRectangle` / `normalizeStroke` 钳制；校验层拒绝未归一化输入）；画笔笔触（点列 + 归一化半径）随 region 持久化，栅格 PNG 按需导出（`exportMaskPngBase64`：全图不透明 + 区域 destination-out 挖空，透明 = edits API 可编辑区）。
2. mask 文件经 `save_visual_project_mask`（Rust：PNG 魔数校验 + 路径穿越防护）落盘，region 只存 maskPath；bitmap 绝不进 Zustand / 项目 JSON。
3. 编辑器 = 全屏 fixed 工作模式（工具栏：返回 / 框选 / 画笔 / 橡皮 / 清除 / 笔刷大小 / 适应窗口 · 100% / 保存区域）；创建草稿是组件局部视图状态，「保存区域」才语义上抛。
4. 生成链路：启用中的栅格区域合成 combined mask（`mask_image` → create_task → Rust edits multipart `mask` 部件，真实传输；文件缺失本地硬失败绝不静默降级）；区域空间指令由 Compiler 编译进 Prompt（位置用归一化矩形 → 画面位置语言，非像素值）。
5. 人物合同 replaceScope='custom_region' 必须指向存在且启用的区域（归一化回落 whole_person；生成门禁拦截停用目标）。

## 10. Prompt Optimizer 权限收缩与分层编译（V4.1）

实例：`src/services/promptOptimizer.ts`（VISION_RECREATION_SYSTEM_PROMPT 规则 0/6c/6d + buildVisionRecreationUserContent【硬性合同】块）+ `project/optimizerContract.ts` + `project/promptCompiler.ts`。规则：

1. 优化器职责 = 「把已确定 Contract 表达成更好的生成语言」；无权裁决人物替换 / 服装来源 / 区域 / 媒介结构 / 用户显式维度（系统提示词规则 0：HARD CONTRACT values are immutable）。
2. `buildOptimizerHardContractLines(project)` 产出合同行（人物决策 / 显式维度 / 服装来源 / 区域 / 媒介结构），置于用户内容最顶【硬性合同】块。
3. Prompt Compiler 分层（固定顺序）：image_role → person_replacement → region → rendering → clothing → dimension → template_preservation → final_description（优化产物只作最终画面描述层）；负面词单独走 negativePrompt 字段。`carry.promptCompiled=true` 时 carryApply 禁止二次前置指令（同合同双份 = 违规）。
4. 编译块文案锚点：`【人物替换合同（强制执行）】`（strict 含「禁止从图片1提取或保留人物的脸部身份」；natural 明示「不承诺保留参考图人物的具体面部特征」——禁止超出模型能力的口径）、`【区域编辑合同`、`【服装合同】`（preserve_original 含「保留服装 ≠ 保留人物」）、`【模板保留合同】`。
