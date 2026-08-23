# Visual Workflow（视觉理解复刻工作流 UI Pattern，V4.1）

> 实例：`src/pages/VisionUnderstanding.tsx`（理解 → 修改 → 优化 → 审 Prompt → 生成 → 评价 → 反馈 → 迭代）。
> 状态机 / 守卫 / 文案唯一来源：`src/features/vision/recreationPlan.ts` + `recreationCopy.ts`。

## 1. 工作流全链

```text
上传 / 选择参考图
→ AI 理解（VisualAnalysisProgress：参考图缩略图 + 创意文案轮播 + 扫描反馈；summary 常驻，详细折叠）
→ 选择修改维度（ModificationChip 结构化选择器）+ 自由文本 + 人物替换 + 服装策略
→ 优化复刻 Prompt（AI 返回 changed_dimensions = 结构化修改意图）
→ 立即看到：最终生图 Prompt + 本轮修改 Diff
→ 确认生成（守卫按 semanticRevision 拦截未优化修改；提交 = 显示值）
→ 生成图片（ResultGallery 缩略图，无页面内重复大图）
→ 缩略图下方立即看到：复刻完成度 + 指标 + 👍/👎 + ♡
→ 继续调整（反馈回填自由文本，只填充不自动触发）
```

## 1a. Visual Analysis Loading Pattern（分析阶段产品化反馈，V4.1）

实例：`src/features/vision/VisualAnalysisProgress.tsx` + `recreationCopy.ts#ANALYSIS_PROGRESS`。规则：

1. **只在真实 `analyzing` 阶段渲染**：文案轮播发生在同一真实视觉分析阶段内（`getVisualAnalysisMessage(index)` 确定性取模，非随机）；禁止伪造 upload/parse 子阶段或「75%」类伪精确进度；高复刻循环各阶段仍用通用 stage bar。
2. **绑定当前参考图缩略图**（本地重读，不生成装饰图）；动效限轻量扫描线 + 呼吸边框（品牌色 color-mix，禁止霓虹 / Cyan / 粒子）。
3. **prefers-reduced-motion**：关闭扫描与轮播动画，保留静态状态（副标题 + 模型名仍展示）。
4. **失败即停**：失败由 errorText 卡片呈现真实错误摘要；组件随 analyzing 结束卸载，轮播 interval 在 effect cleanup 中清除，绝不出现失败后文案继续滚。
5. 固定结构：缩略图（84px 呼吸描边）+ 主文案（轮播）+ 副标题（正在识别人物、动作、构图与风格）+ 模型标签。

## 1b. Modification Dimension Selector（快捷修改维度选择器，V4.1）

实例：`src/features/vision/ModificationChips.tsx` + `modificationIntent.ts`。规则：

1. **快捷按钮是结构化选择器，不是 textarea 文本追加**：状态唯一来源 = workspace `modificationDraft.activeDimensions`；禁止 `textarea.includes()` 反推选中态，禁止 append「修改风格：」协议。
2. **同一维度唯一槽位**：再次点击 = 取消并删除该维度结构化意图（连点 N 次永不产生重复槽位）；不同维度可同时激活（人物 + 动作 + 背景 + 风格）。
3. **「提高复刻度」不是视觉维度**：独立 `replicationBoost` 开关（preservation strength），虚线边框 Chip 区分。
4. 选中态：`✓ 前缀 + aria-pressed + Brand Soft`（`--accent-primary-light` 底 + 主色描边 + 主色文字）；未选 = 普通 Chip；与 Primary CTA 不同强度。键盘可用 + focus-visible 描边。
5. 维度定义单一来源 `MODIFICATION_CHIP_DEFS`（subject/pose/scene/camera/style/clothing），映射到 `RecreationFieldKey`；**禁止另建冲突 enum**。

## 1c. Person Replacement Pattern（人物替换输入器，V4.1）

实例：`src/features/vision/PersonReplacementPanel.tsx`。挂在「修改人物」维度激活时展开。规则：

1. **三种人物来源**（tab 语义，role=tablist）：图片库人物（复用图库弹层，无可靠人物分类时不假装智能过滤）/ 本地导入（文件选择）/ 文字描述（textarea）。来源 Tab 切换是视图操作；真正落语义的是人物数据（参考图 / 非空描述）。
2. 人物参考图语义 = 身份 / 脸部 / 发型 / 体型；是否采用其服装由 ClothingPolicy 决定，禁止偷偷跟随。
3. 缩略图点击进全局 ImageViewer（禁止再造 Preview Modal）；「更换人物」「移除人物替换」为 secondary 按钮。
4. **移除人物替换**：删 person 数据 + 解除 subject 维度 + 仅因人物产生的服装自定义回默认；不触碰其它维度与自由文本。
5. 人物参考图（i2i）经 GenerationCarry.personReferencePath 作为第二张参考图带入图片工作室。

## 1d. Clothing Policy（服装处理，V4.1）

1. `ClothingPolicy = 'preserve_original' | 'use_subject_reference' | 'custom'` 严格单选（radiogroup + checked 样式，不只靠颜色）。
2. 默认推荐「沿用原图服装」：用户只说「换一个人」→ subject 修改、clothing 锁定原图。
3. `use_subject_reference` 仅在有图片参考时提供；`custom` 附「描述新的服装 / 造型」输入。
4. 「服装 / 造型」（clothing）是独立复刻维度（第九维）：只改服装时 subject 保持锁定；人物描述含服装（「黑发男性，穿白色西装」）→ AI 判 subject + clothing 双修改（优化器系统提示词规则 5/6）。
5. 合成指令必须显式写出服装保留 / 替换约束（`clothingPolicyInstruction`），禁止只给模型一句「换这个人」。

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

## 3. Dimension Lock（维度锁定三来源，优先级强制）

```text
User Override（用户手动切换） > Modification Intent（AI 按意图判定） > Default Preservation（默认保留）
```

- `lockSource`: `user_override`（硬约束，重新优化不得覆盖）/ `intent`（本轮 AI 判定）/ `default`（软约束，AI 可按意图打开）。
- 修改意图来自优化器输出的 `changed_dimensions` / `dimension_values`（结构化，九维含 clothing），**禁止前端 includes() 猜维度**。
- 维度卡角标四态：`锁定` / `可修改` / `已修改`（值变化且未锁定，success soft 色）+ `·手动` 后缀（user_override 标识）。
- 模糊意图（如「更梦幻」）只开放 style/lighting/color 类贴切维度，禁止大面积解锁。
- 自由文本与快捷维度共存：优化器输入 = `buildModificationInstruction` 合成指令（freeText + 重点修改维度 + 人物替换 + 服装处理 + 复刻强度）；AI Intent Recognition 仍独立判定 freeText 中提到的维度，快捷按钮只是帮助表达，两种信息都不能丢。

## 4. Prompt Diff（修改对比）

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
