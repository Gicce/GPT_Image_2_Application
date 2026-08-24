# cyimagepro-ui CHANGELOG

## Skill 14.0.0 / UI System 1.2.0（2026-08-24，V4.2 CY Credits Billing）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **patterns.md 新增 §21-§24**：Credits Billing / Trial Entitlement / Generation Quote /
  Wallet-Ledger / Pricing Transparency 五大计费交互模式（V4.2 铁律：生成前报价确认、
  客户端禁止自行计价、三类点数钱包、采购成本不出现在用户界面）。

---

## Skill 13.0.0 / UI System 1.2.0（2026-08-24，V4.1 Task Queue Reliability & Failure UX）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **SKILL.md 新增最高优先级规则 21（Task Failure UX 铁律）**：
  - Friendly error summary MUST be separated from technical diagnostics（raw error 进「技术详情」折叠区且必须保留）。
  - TaskQueue is operational status UI; History is full audit UI（禁止第二套 Task Detail，深链 openTaskDetailFromQueue）。
  - Terminal tasks MUST expose a terminal timestamp（resolveTaskFinishedAt 唯一入口，缺失显示「—」，禁 Date.now() 伪值）。
  - Native browser/system alerts MUST NOT be used for task retry feedback（一律应用内 Toast）。
  - 状态聚合唯一入口 deriveTaskState（sub_tasks 事实派生六态）；失败分类唯一入口 classifyGenerationFailure（canonical failure model）。
- **patterns.md 新增 §20 Task Failure UX Pattern**（8 条：分层呈现 / 分类唯一入口 / 状态派生 / 队列与历史职责 / 终态时间 / 终态按钮契约 / Toast 重试 / 失败 slot 精确重试与 attempt 历史）。
- **copy.md 新增 §13 任务失败 / 重试 / 时间**：生成中（替代执行中）/ 部分完成 / 开始·结束·耗时 / 十一类失败标题与建议 / 重试 Toast 固定文案 / 技术详情字段名与 Endpoint 脱敏格式。
- **layouts.md §6**：补 TaskQueue 任务卡 V4.1 结构（时间块 / 失败卡 / 终态按钮 / 长 Prompt 折叠）。
- **components.md**：新增 taskState.ts / taskFailure.ts / taskNavigation.ts 三个唯一入口条目；subtaskError.ts 已删除（禁止复活第二套分类）。
- SKILL.md：版本 12.0.0 → 13.0.0（规则变更）。

配套代码（V4.1，未发版）：

- Rust：`task_failure.rs`（canonical 分类 + request_id 提取 + cargo tests）；`SubTask.error_detail / attempt_details` 结构化快照（serde default 兼容旧 tasks.json）；`send_with_transient_retry` 返回结构化 `SendFailure`；reconciliation reset 清 error_detail；attempt 历史双轨（errors + details，尾部对齐）。
- TS：`utils/taskState.ts`（deriveTaskState 六态 + resolveTaskFinishedAt + taskDurationMs）；`utils/taskFailure.ts`（classifyGenerationFailure + describeEndpoint + attemptFailureHistory）；`utils/taskNavigation.ts`（History 深链）；TaskQueue 重构（Toast 重试 / 终态按钮 / 时间块 / 失败卡 / 接口脱敏）；History（派生态 + 结束时间/耗时 + 失败友好标题 + 深链选中）；EditTaskModal 去 alert；App.tsx focusTaskId 仅 queue 页写队列键。
- 测试：vitest 新增 7 套（taskTerminalState / taskFinishedAt / taskFailureClassifier / taskFailurePresentation / taskRetryInteraction / taskQueueHistoryNavigation / taskRetryAlertGuard）。

## Skill 12.0.0 / UI System 1.2.0（2026-08-24，V4.1 Workbench V2 视觉项目工作台）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **SKILL.md 新增最高优先级规则 16–20**：
  - **16. Creative Workflow MUST use Adaptive Workbench Layout**（`.vision-workbench` 双栏断点体系；禁窄容器回归；CTA 唯一渲染处 = Context Rail）。
  - **17. Visual Project Pattern**（Template=baseline / Modification=overlay；修订白名单；恢复绝不重分析；Effective Plan 唯一合成视图；生成硬门禁只认语义错误）。
  - **18. Identity != RenderingMode**（人物参考「是谁」≠ 媒介「怎么画」；风格修改不改写层模式；混合媒介分层铁律）。
  - **19. Region Editing Contract**（坐标归一化 0..1；mask 文件路径引用；全屏编辑器；语义通道写区域）。
  - **20. Prompt Optimizer 无合同裁决权**（HARD CONTRACT values are immutable；Compiler 分层编译；promptCompiled 禁双份指令）。
- **visual-workflow.md 新增 §7–§10**：Visual Project Pattern / Identity vs RenderingMode / Region Editing Contract / Optimizer 权限收缩与分层编译（含编译块文案锚点）。
- **layouts.md 新增 §9 Visual Project Workbench**（Golden Sample 结构 + 断点规则 + 源码契约测试索引）。
- SKILL.md：版本 11.0.0 → 12.0.0（规则变更）。

配套代码（V4.1 Workbench V2，未发版）：

- 新模块 `src/features/vision/project/`（types/project/personContract/rendering/region/template/validators/effectivePlan/promptCompiler/optimizerContract/migrate + __tests__）；`src/store/useVisualProjectStore.ts`；`src/features/vision/region/`（RegionEditorPanel/RegionCanvasEditor/regionMask）；`ContextRail.tsx` / `ProjectHeaderBar.tsx`。
- Rust：`visual_projects` 表 + `visual_projects.rs` 六命令（list/load/save/rename/delete/save_mask；PNG 魔数 + 路径穿越防护）；`Task.mask_image` / `CreateTaskParams.mask_image` 全构造点透传；`edit_single_image` multipart `mask` 部件（文件缺失本地硬失败）。
- `VisionUnderstanding.tsx` 工作台化（ProjectHeaderBar + workbench 双栏 + Region 面板 + 换图确认 + 硬合同行进优化器）；`PersonReplacementPanel` V2 合同控制区（强度/范围/身份应用/区域绑定）；`promptOptimizer.ts` 规则 0/6c/6d + 【硬性合同】块；`carryApply.ts` promptCompiled 分支；History 项目来源/区域/媒介段 + mask 缩略图。
- 测试：vitest 1013 → 1096（project 域 63 + store 8 + 编译器 9 + 布局契约 7 + History 契约 8 等）；cargo 205 → 207。

## Skill 11.0.0 / UI System 1.2.0（2026-08-24，V4.0.9 任务详情语义重构 + 服装策略状态冲突修复）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **SKILL.md 新增最高优先级规则 15（三层 Provenance 与服装状态不变量铁律）**：
  - **User instruction, structured modification plan, and final execution prompt are three distinct provenance layers and MUST NOT be conflated.**（用户原话 / 修改方案 / 最终执行 Prompt 三层溯源严禁混淆）
  - **clothingPolicy=preserve_original and clothing=modified is an invalid semantic state.**（`clothing ∈ activeDimensions ⇔ clothingPolicy ≠ 'preserve_original'`）
- **visual-workflow.md §1d**：服装状态不变量完整落地规则——唯一归一入口 `normalizeModificationState` 覆盖全部写入路径（toggle / setClothingPolicy / clearPersonReplacement / 持久化恢复 / store setter 收口）；Chip 点击自动切换策略（有人物参考→人物服装，无→custom 等描述）；选「原图服装」自动取消维度、选「人物服装 / 自定义」自动启用；custom 空描述 `clothingReadinessError` 拦截优化与生成；「可修改 N」计数以 activeDimensions 为单一事实源；优化器系统提示词规则 6 三态硬性对应。
- **visual-workflow.md 新增 §1h Generation Provenance Snapshot**：快照字段（userInstruction（@token→@label）+ userInstructionRaw + mentionBindings / modificationIntent / imageRoles / models）；冻结链（generateFromPlan → carry → VisionCarryDraft → CreateTaskParams → Rust Task.provenance JSON 透传 + task_source='vision_recreation'）；历史详情四层结构 + 小节序号不跳号。
- **patterns.md §15**：新增服装不变量与生成溯源两条要点（含旧任务兼容：无快照如实「未保存」、参考图只编号不猜角色）。
- **components.md**：modificationIntent.ts 条目补 normalizeModificationState / setClothingPolicy / clothingReadinessError；新增 generationProvenance.ts 条目。
- **copy.md 新增 §8b 任务详情四层结构**：用户要求 / 本次修改方案 / 参考图片（画面模板 / 人物参考 / 背景参考 / 风格参考 / 参考图）/ 最终执行 Prompt（正向）/ 模型执行记录 / 任务来源：视觉复刻，及各禁止变体。
- SKILL.md：版本 10.0.0 → 11.0.0（规则变更）。

配套代码（V4.0.9 任务详情语义重构）：

- **新模块 `src/features/vision/generationProvenance.ts`**：`buildGenerationProvenance`（生成时刻冻结快照）、`renderUserInstruction`（@token→@label 人类可读）、`describeProvenanceModificationPlan`（历史「本次修改方案」结构化行）、`describeClothingPolicy`、`PROVENANCE_ROLE_LABELS`。
- **modificationIntent.ts**：新增 `normalizeModificationState`（biconditional 不变量）/ `setClothingPolicy`（radiogroup 唯一写入口）/ `clothingReadinessError`（空描述守卫）/ `MODIFICATION_DIMENSION_LABELS` 导出；`toggleModificationDimension` clothing 分支自动切换策略、取消回到原图服装；`clearPersonReplacement` 保留显式服装修改（降级 custom）；`migrateModificationDraft` 恢复即归一（矛盾态 legacy 数据自动修复）；服装修改指令行改为「必须真实修改并列入 changed_dimensions」。
- **useVisionWorkspaceStore.setModificationDraft**：最终收口 normalize（任何写入路径不可能留下矛盾态）。
- **promptOptimizer.ts**：系统提示词规则 6 增加「服装处理指令 ↔ changed_dimensions 硬性对应」三态契约。
- **VisionUnderstanding.tsx**：`onClothingPolicyChange` 走 `setClothingPolicy`；优化 / 生成入口空自定义守卫；维度计数以 activeDimensions 为准（Chip 已启用即「可修改」）；`generateFromPlan` 构建并携带 provenance 快照。
- **recreationPlan.ts / useDraftStore.ts**：carry 增加 `provenance` 字段透传。
- **ImageStudio.tsx**：视觉复刻链路 `task_source='vision_recreation'`（不再「手动」fallback）+ provenance 提交透传。
- **Rust**：`Task.provenance` / `CreateTaskParams.provenance`（`Option<serde_json::Value>`，serde default 兼容旧 tasks.json）；`create_task` / 整批重提 / 批量重做透传保留（6 处 Task 构造点同步）。
- **types/index.ts**：`GenerationProvenanceSnapshot` 数据契约（自包含无反向依赖）；Task / CreateTaskParams 挂载 + task_source 联合类型扩 'vision_recreation'。
- **History.tsx / History.css**：任务详情重构为 ① 任务概览 ② 用户要求（快照 userInstruction；旧视觉任务明示未保存，禁止 final_prompt 伪造）③ 本次修改方案（结构化行）④ 参考图片（角色标签；旧任务「参考图 N」）⑤ 最终执行 Prompt（final_prompt 快照 + 复刻原始 Prompt 折叠；无负面时不再重复展示拼接版）⑥ 模型执行记录（生成时快照，Prompt 优化回落 prompt_optimization 字段）⑦ 生成结果；参考图 / 结果图 / 方案抽屉结果图全部点击进全局 ImageViewer（结果图携带实际提交 Prompt）；小节序号动态取号不跳号。
- **recreationCopy.ts / ClothingSourceControl.tsx**：三来源副文案标注维度自动启用 / 取消。
- 测试：vitest 934 → 964（新增 clothingInvariant 16：Case A–D + 持久化归一 + 四处一致；generationProvenance 14：快照冻结 / token 解析 / 角色去重 / carry 透传 / 方案行 / 旧任务空快照；修正 useVisionWorkspaceStore 1 例矛盾态夹具）；cargo 205（provenance 字段全构造点编译验证）；tsc + build 全绿。

## Skill 10.0.0 / UI System 1.2.0（2026-08-24，V4.1 视觉链路三轮修复：mention 对齐 / 维度强制生效 / 先摘要后全文）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **visual-workflow.md §1g**：新增**度量对齐铁律**——textarea 必须 `font-family: inherit`（UA 默认 Arial 与页面字体中文字宽不同 → 逐行漂移重叠）；token pill 禁止 font-weight / padding；换行属性只用 pre-wrap + overflow-wrap；token 16 字上限 + 省略号；chip 显示 `@{label}` 非 token。
- **visual-workflow.md §3**：新增**（V4.1 铁律）启用 = 必须真实修改**——Chip 启用维度三层强制（逐维度 must-change 指令行 + forcedDimensions 方案行标记 + 系统提示词规则 2a 不受「禁止大面积放开」约束）；user_override 锁定仍最高优先；人物替换模板行按已启用维度动态表述。
- **visual-workflow.md §4**：新增**先摘要、后全文**——FinalPromptEditor 顶部「本次重点修改」结构化摘要（buildPromptChangeSummary，人物/动作/背景/服装分组 + 待优化/已修改状态）；Diff Tab 底部「本次关键变化」。
- **visual-workflow.md §1c**：新增**真实大图预览**（usePersonThumb 两级加载 + contain 不裁切，禁止 4:3 cover）与**「当前规则」动态 modify 行**（activeDimensions 增补修改行、保留行剔除已启用维度）。
- SKILL.md：版本 9.0.0 → 10.0.0（规则变更）。

配套代码（V4.1 未升版本轮次）：

- `modificationIntent.ts`：新增 `dimensionDirectiveInstruction`（pose/scene/camera/style/clothing must-change 行）；`buildModificationInstruction` 输出逐维度指令 + 纯文本 subject 行；人物替换行强化「整体替换 + 不保留旧人物长相」；`clothingPolicyInstruction` 人物服装分支强化「不仅替换脸部 + 继承服装造型」；模板行按已启用维度动态表述。
- `promptOptimizer.ts`：`VisionRecreationOptimizeInput.forcedDimensions`；`buildVisionRecreationUserContent` 方案行三态（user_override / 用户显式要求修改 / 自动）；系统提示词规则 2a。
- 新模块 `src/features/vision/promptChangeSummary.ts`：结构化修改摘要纯函数（指令行 + 维度 Diff 双源派生，planned/applied 两态，一句话截断）。
- `usePersonThumb.ts`：两级加载（缩略图 → readImageData 原图，防乱序覆盖）；`replacementRules.ts`：modify 行 + 保留行动态；`imageMention.ts`：token 16 字截断。
- `VisionUnderstanding.tsx/.css`：forcedDimensions 接线、修改摘要 UI、mention 字体对齐修复、人物卡 contain 大图。
- 测试：vitest 916 → 934（新增 promptChangeSummary 7、dimensionDirective / forcedDimensions / modify 行 / token 截断等）；cargo 205 无 Rust 变更；tsc + build 全绿。

## Skill 9.0.0 / UI System 1.2.0（2026-08-24，V4.0.9 @图片引用 + 人物替换双图角色语义）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **visual-workflow.md**：新增 **§1g Image Mention（@图片引用）强制契约**——In Vision Workflow, @image mentions MUST resolve from current task/conversation images first（候选唯一来源 buildVisionContextImages，当前任务隔离）；mention 是真实图片引用（token 在 freeText + mentions 侧车表绑定 assetId/path/role）；原生 textarea + 背景高亮层（IME 安全，禁止富文本编辑器）；弹层纯视图不 dirty；**When a task involves "replace the person in image A with the person from image B", the system must preserve the semantic roles of both images**（A = template/style/composition reference，B = person replacement reference）；优化器清单 ↔ parts 一一对应。§1c 升级为**人物替换业务卡**（**Person Replacement is a first-class business action, not a weak advanced form section**：👤 卡头 + 已启用徽章 + A 区画面模板 / B 区替换人物双区）；§1d 服装口径升级「沿用模板图服装」；工作流全链补 @引用与多图 multimodal。
- **patterns.md**：新增 **§19 Image Mention Pattern**（候选池 / 真实引用 / IME 安全 / 纯视图不 dirty / 双图角色语义 / 优化器双图 payload 六条规则）。
- **components.md**：新增 IntentMentionInput / imageMention.ts 条目；PersonReplacementPanel 更新为业务卡双区描述；modificationIntent.ts 补 mentions / extraImageRefs。
- **copy.md**：§8a 扩充——人物替换业务卡（已启用徽章）、画面模板 / 替换人物（A/B 区）、更换模板图、沿用模板图服装（口径含模板图）、引用图片 / 当前任务（弹层）、已引用图片（chips）、已识别图片角色 / 应用到人物替换（建议条）、池角色标签（主参考图 / 人物参考 / 生成结果 N / 图片引用，禁止无语义「图1 / 图2」编号）。
- SKILL.md：版本 8.0.0 → 9.0.0（规则变更）。

配套代码（V4.0.9 Image Mention + Person Replacement Dual-Role）：

- **新模块 `src/features/vision/imageMention.ts`**：图片角色语义（template_reference / person_replacement_reference / source_reference / generated_result_reference / background_reference / generic_reference + 中文标签与用途说明）；`buildVisionContextImages` 当前任务图片池唯一 selector（人物参考置顶 → 主参考图 → 图库附加 → 生成结果；路径归一去重 + 角色优先级）；mention token 插入 / 定位 / 清理（`insertMentionToken` / `findMentionTokens` / `pruneMentions` / `removeMentionToken` / `detectMentionTrigger` 邮箱防误触）；`resolveImageMentionRoles` 双图角色解析（面板显式 > 明确 Mention > 自然语言推断；动词前后定位 + 像/参考句式 + 「图N」文件名 / 池序号匹配）。
- **新组件 `src/features/vision/IntentMentionInput.tsx`**：原生 textarea + `.vision-mention-backdrop` 背景高亮层（同度量对齐 + 滚动同步，token pill 无额外 padding）+ @ 弹层（缩略图 + 名称 + 用途 + 角色标签，键盘 ↑↓/Enter/Esc，isComposing 防输入法冲突）+ 引用 chips 行（hover 缩略图 / 点击进全局 ImageViewer / × 移除）+ 图库回填一次消费；弹层为纯视图状态（组件不 import workspace store）。
- **modificationIntent.ts**：ModificationDraft 新增 `mentions` / `extraImageRefs`（持久化迁移 + 合法化去重）；`buildModificationInstruction(draft, context?)` 新增图片引用绑定行、双图工作流行（「画面模板：以「X」为画面模板——延续其画风…」）、面板为空时人物来源 mention 行；服装指令口径「严格保留原图（画面模板）服装」。
- **promptOptimizer.ts**：`imageReferences` 输入（+ `OptimizerImageReference` / `describeOptimizerImageReference` / `collectOptimizerImageReferences` 去重排序 / `buildImageReferencesBlock` 清单）；多模态装配改为逐图 readImageData、清单 ↔ parts 一一对应（失败图不进清单不占序号）；系统提示词新增规则 6a（模板图风格延续 + 人物图仅身份特征 + 不得把模板图风格替换成人物参考图的写实风格）；personReferencePath 旧参数并入去重。
- **PersonReplacementPanel.tsx**：业务卡重构——👤 卡头（已启用徽章 + 业务说明 + 移除）+ A 区画面模板（当前任务参考图缩略图 / 当前使用：@原图 / 更换模板图（tooltip 声明会重置分析））+ B 区替换人物（三来源 tab）+ C 区服装（模板图口径副文案）。
- **VisionUnderstanding.tsx**：当前任务图片池接线（generatedResults 从本视觉任务 source_task_id 过滤）；IntentMentionInput 替换裸 textarea；「已识别图片角色」建议条（面板为空才出现，应用走 onPersonChange 正常语义通道，忽略为视图）；图库 purpose='mention'（加入 extraImageRefs + 一次消费回填）；优化调用携带 buildOptimizerImageReferences（模板 + 人物 + @引用）；commitModificationDraft / optimizeRecreationPrompt 合成指令带双图上下文。
- **recreationCopy.ts**：ADJUST_INPUT 新 desc/placeholder（输入 @ 引用当前任务图片 + 图二图三示例）；新增 IMAGE_MENTION / MENTION_SUGGESTION 文案块；PERSON_REPLACEMENT 业务卡文案；CLOTHING_POLICY 模板图口径。
- 测试：vitest 899（新增 imageMention 20：池去重/隔离/置顶、token 插入定位清理/触发边界、双图角色 §10 四例 + 面板优先级 + 无线索不瞎猜；optimizer imageRefs 10：汇总去重排序 / 清单角色标注 / parts 装配契约；页面契约 16：池唯一来源/任务隔离、mention 真实引用/IME/纯视图、业务卡双区、建议条不覆盖、payload 双图）；cargo 205（无 Rust 变更）；tsc + build 全绿。

## Skill 8.0.0 / UI System 1.2.0（2026-08-24，V4.0.9 视觉理解结构化响应容错）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **visual-workflow.md**：新增 **§0 Vision Response Tolerance & Error Presentation 强制契约**——Internal transport / parser / schema errors MUST NEVER be exposed directly in user-facing UI；Hiding an error message is NOT error recovery（恢复在 Rust 规范化层：normalize → validate → 同一模型最多一次 repair，UI 只做映射拦截）；失败保留旧成功分析；修复过程用户无感（不出现「正在修复 JSON」类文案）；schema 漂移 ≠ 模型不可用（绝不触发无关模型 fallback）；normalization 不触碰 semanticRevision。§1a 规则 4 衔接错误映射层。
- **patterns.md**：§8 Loading / Error Retry 新增「AI 结构化响应错误的呈现铁律」三条（同上，适用所有 AI 结构化功能）。
- **copy.md**：§8a 新增**视觉理解失败文案表**（schema_error 固定文案 / 有旧结果前缀 / 兜底 / 未配置）+ 禁止用户可见词清单（invalid type / sequence / serde / JSON / schema / 解析器 / 反序列化）。
- SKILL.md：版本 7.0.0 → 8.0.0（规则变更）。

配套代码（V4.0.9 Vision Schema Tolerance）：

- 根因：`vision.rs` 严格 `serde_json::from_value::<VisionAnalysis>` 遇到 GLM-5V-Turbo 的合理类型漂移（String 字段返回 array）→ `invalid type: sequence, expected a string` 整次失败，serde 细节直透 UI。
- **Rust 新模块 `vision_normalize.rs`**：schema 驱动规范化边界（Tolerant External → Canonical Internal）——String-Like（string / array「；」稳定合并 / object 语义 key description·text·value·name·summary·content·label / null→默认）、数组语义字段保持数组（单字符串包装、object 采集字符串叶子）、数字 / 布尔 / 区域（[x,y,w,h] 四元组）归一；逐字段修复报告（`$.subjects[0].clothing expected=… actual=… action=…`）只进 `[VisionSchema]` 开发日志；Canonical DTO 保持严格类型不变。
- **vision.rs 管线重写**：extract → 解包（analysis/result/comparison）→ normalize → 严格 validate → 内容校验；失败且可修复 → **同一模型最多一次结构修复**（REPAIR_SYSTEM_PROMPT 只修结构不改内容；不切换模型路由）；最终失败 kind=`schema_error` 产品级文案。分析 / 双图比较两条链路同架构；Transport `extract_chat_content` 早已兼容 content string / parts 双形态（本轮补测试锁定）。
- **Prompt 契约强化**：分析 System Prompt 新增字段类型硬规则（字符串字段禁数组 / 对象）；比较 Prompt 新增分数小数 + 数组规则。
- **TS `src/features/vision/visionErrors.ts`**：`mapVisionErrorToUserMessage`（kind 映射 + isTechnicalErrorMessage 拦截）；VisionUnderstanding 三处失败分支接入；重新理解失败提示「仍保留上一次分析结果」；高复刻失败同样过映射。
- 测试：vitest 848（新增 15：visionErrors 映射与拦截 / store 旧分析保护与 semanticRevision 不变 / UI Error Guard 源码断言）；cargo 205（新增 20：规范化矩阵 / Fixture A·B·C / content 双形态 / repair 构建器 / 比较漂移）；tsc + build 全绿。

## Skill 7.0.0 / UI System 1.2.0（2026-08-24，V4.1 AI Model Routing：AI 功能模型路由全链）

规则层（无 Token 变更，UI System 保持 1.2.0）：

- **新增 ai-model-routing.md（§11 专项规范）**：AI Model Role 目录（8 个真实 role，禁止虚构）、resolveModelForRole 唯一解析入口、manual/follow/default/fallback 四来源语义、显式 fallback 规则（vision_prompt_optimizer 可跨类别回退 / image_evaluation 禁止跨类别回退）、@图片多模态上下文契约（vision 能力模型收真实 image_url；纯文本模型只收结构化描述）、设置页「AI 模型使用」布局、运行时可见性、Provenance 快照、测试守卫清单。
- **SKILL.md**：最高优先级规则新增第 12 条 **AI Model Routing 铁律**——No AI feature may silently inherit an unrelated global model / Every AI model invocation must have an explicit model role / Displayed model MUST equal resolved runtime model；版本 6.0.0 → 7.0.0（规则变更），索引新增 11。
- **patterns.md**：新增 §1a AI Model Routing 模式（取模型一律 resolveModelForRole；显示=执行；fallback 可见；配置来源四词）。
- **components.md**：新增 AiModelUsageSettings / resolveModelForRole / useAiModelRoutingStore 条目；ModelPicker 行补 role 能力过滤（roleModelFilter.buildRolePickerGroups）。
- **copy.md**：新增 **§12 AI 模型使用**——设置页固定名「AI 模型使用」、8 个功能行名、配置来源四词（单独指定 / 跟随「X」 / 系统默认 / 当前回退）、分组名（视觉与复刻 / 图片创作 / AI 智能体）、恢复推荐设置、视觉页优化标签 / 优化中按钮 / Fallback hint·Toast / Provenance 全套固定文案。
- **visual-workflow.md**：工作流全链补 role=vision_prompt_optimizer 路由与多模态说明；§2 补「（V4.1）优化模型可见性」规则。

配套代码（V4.1 AI Model Routing）：

- **根因修复**：`optimizeVisionRecreation` 原走 `resolveByokConfigForUse('prompt_optimizer')`（只在 agent 档案解析 → 静默继承 agent 默认 deepseek-v4-flash，与视觉页显示的 GLM-5V-Turbo 不符）。改为 `resolveModelForRole('vision_prompt_optimizer', { visionPreferred })`：默认跟随视觉理解模型；视觉不可用 → 显式回退提示词优化链（source='fallback' + 原因，Toast 可见）。
- **新模块 `src/features/aiRouting/`**：modelRoles.ts（角色目录 + 两条铁律）、modelRoutingPolicy.ts（ai_model_routing_v1 持久层，只存用户改过的条目 + 进程内最近使用）、resolveModelForRole.ts（唯一解析入口 + manual 失效显式回退 + follow 环免疫）、roleModelFilter.ts（能力过滤纯函数）、aiRoutingLog.ts（[AITransport] 日志 + describeFallback）、AiModelUsageSettings.tsx（设置页）。
- **全部 AI 入口接入**：optimizePrompt（image_prompt_optimizer）、batchPlanner（batch_planner，默认跟随图片 Prompt 优化）、evaluationService（image_evaluation，默认跟随视觉理解）；chat / interpret / plan_task / 深度检测 / Agent Prompt 生成器 payload 补 role/feature 标注。
- **Rust**：AgentRunPayload 新增 role/feature（serde default，仅日志）；`[ChatTransport]` 日志行升级 `[AITransport] role=… feature=… mode=… model=…`；vision_analyze_image / vision_compare_images / evaluate_image 命令入口打印同格式日志（禁止输出密钥）。
- **@图片**：优化器模型 capabilities 含 vision 且有人物参考图 → readImageData data URL 以 image_url part 进入真实 multimodal payload（optimizerReceivedPersonImage 如实记录）；纯文本模型只收结构化描述。
- **运行时可见性**：视觉页优化按钮旁常驻「Prompt 优化 · {模型} · 跟随视觉理解/单独指定/当前回退」；优化中按钮带模型；fallback warn hint + 成功 Toast；FinalPromptEditor 头部「由 {模型} 优化 · HH:MM」；确认生成弹层四行模型快照（视觉分析 / Prompt 优化 / gpt-image-2 / AI 评价）。
- **Provenance**：RecreationState 新增 optimizerModelId/optimizerProviderId/optimizerSource/optimizerFallbackReason（applyOptimizationResult 落位并持久化 session）；GenerationCarry.optimization 冻结 modelId/source；旧数据缺失字段不崩溃不伪造。
- **设置页**：设置与更新新增「AI 模型使用」分区（nav 第 5 项）：分组 Role Row（功能/说明/模型+ProviderLogo/计费 BillingBadge/配置来源/最近使用）+ 跟随（推荐）/单独指定 radiogroup + 按 role 能力过滤的 ModelPicker + 单项 / 全局「恢复推荐设置」；external role 跳转既有设置页；gpt-image-2 只读标注「服务端模型」。
- 测试：vitest 833（新增 aiRouting 25：Bug 回归 / manual / follow 切换同步 / 显式 fallback reason / 设置页映射无 undefined / 能力过滤 / @图片 image_url part / UI-only 不弄脏 semanticRevision / provenance 快照与旧数据兼容）；cargo 185；tsc + build 全绿。

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
