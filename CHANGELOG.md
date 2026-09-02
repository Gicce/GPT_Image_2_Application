# Changelog

## v4.3.0 AI 漫画正式加入（AI Comic Official）（2026-09-03）

AI 漫画作为一级功能正式加入 CyImagePro：侧栏新增「AI 漫画」入口（ComicStudio），覆盖从一句话需求到成页成品漫画的完整创作工作流。本版本是 V4.2.3 之后的正式收口发布，包含 V4.2.4 ~ V4.2.13 全部已验证迭代（AI 漫画系列 + Prompt 执行链路 / 批量同效果）与人工验收残留修复。服务端零改动。

### AI 漫画（新功能）

- 完整创作工作流：本期故事 → 画面与形式 → 角色演员 → 分镜草稿 → 生成漫画画面 / 页面 → 对白与字幕；步骤由展示形式动态派生，故事 / 分镜 / 微调草稿随项目持久化（切步骤、刷新、关闭重开全保持）。
- 创意入口与 AI 推荐：可视化形式选择器（四宫格 / 九宫格 / 上下双格 / 左右双格 / 三格竖版 / 单幅 / 多页连载七种模板几何预览）；AI 推荐三方案 Story-first（完整故事、结尾包袱、节拍预演、角色建议）；fixed / auto 形式约束三层契约（Prompt 硬约束 + 结构化 constraint JSON + Validator 硬校验 + 违规定向修复重试）。
- 角色演员体系：演员库（分类 / 搜索 / 深拷贝快照 / 引用计数）；角色参考图生成闭环复用既有报价确认、两段授权、任务队列、结算、图库与历史链路；角色身份去重（characterKey 归一，`鸭妈妈` ≠ `鸭老师` 不误合）；「确认并锁定」单一 Primary + 保存演员库复选项；参考图按角色独立异步状态机（A 角色生成不阻塞 B 提交）。
- 分镜与生成：分镜直排版（Presentation 几何网格，每格即分镜卡、只 Patch 本格）；排版顺序唯一事实 = `panel.order`（任务完成顺序 3,1,4,2 回放排版仍 1,2,3,4 阅读序；上移 / 下移只改排版不重生成图片）；单页生成编排一次全量提交（锁定角色参考真实入槽 + 编译期冻结 Prompt + 单格画面铁律）；最终页本地组合（1080×1440 几何单源，零 Image2 调用）+ fit-safe 槽位适配（等比居中不再暴力裁切，比例一致时与原行为逐值等价）。
- 文字层：七类气泡（经典对白 / 圆润对白 / 思考 / 旁白框 / 喊话 / 低声 / 无气泡文字）共享 SVG 几何单源（Picker 预览 / 画布 / 导出三处同源）；气泡画布直接编辑（点选放置 / 拖动 / 四角缩放 / Esc 取消 / 双击编辑文字）；共享字体选择器 FontSelect（未知字体回退项，受控 select 永不空白）；AI 对白导演（规划 / 视觉摆放 / 组合 / 烘焙四种模式；fill 默认只补空白，整格重写需显式选择并预览确认后才写库）；Story Lock（人工对白出身最高优先，故事重新确认时旧分镜与对白归档并明示数量）。
- 结构化返回 P0 修复：大 JSON 调用显式输出预算 8192（根因：reasoning 模型 reasoning 与正文共享 max_tokens，4096 必截断）+ 解析 / 校验失败定向修复重试 + 有限容错；规划进度诚实呈现（真实阶段清单 + 真实计时 + 真实模型名，无伪造百分比）。
- 持久化兼容与几何纵深防御：旧项目气泡几何证据化迁移（位置 >1 视为百分比刻度、px 尺度无依据则回内容自适应，绝不钳成整格气泡）；渲染边界 sanitize（NaN / Infinity / 巨值进不了 DOM 与 canvas）；打开 ≠ 保存（打开项目只刷新 lastOpenedAt，迁移结果仅存内存，用户编辑后才落库）；对白编辑纯文字层零 Image2 调用。
- 真实项目验证：《鸭梨山大 · 第一期》全链路 gated E2E（`V4211_E2E=1` 才运行，默认跳过）——演员去重 / 异步参考证据 / 分镜定稿 / 系列任务构建 / 真实计费 quote→authorize→edits→settle（失败全额退）/ 组合最终页 / 对白编辑零生图重组合 / 落库重载还原。

### 生成链路（V4.2.4）

- Prompt 执行快照：提示词、负面提示词与真实发送指令在生成前冻结，历史记录按快照展示 Prompt 来源与完整指令，旧版本任务如实标注「未记录完整执行快照」。
- 批量同效果生成：从成功任务创建系列批量（任务队列成功卡 / 历史详情 / 批量页「从已有任务导入」三个入口），来源 Prompt 拆分固定部分与主题变量槽，逐项预览 / 编辑 / 禁用后批量生成，支持跳过已完成主题、继承参考图与成功结果图，失败项单独重试。
- 图生图恢复「AI 智能规划」纯文本入口（与「视觉理解优化」双入口共存）；负面提示词进入图生图与批量执行链路；需求或参考图变化后旧优化结果标记过期并明示。

### 验证

- 发布实测：typecheck 通过；AI 漫画 focused 76 文件 1092 用例通过（10 skipped = E2E 门控）；vitest 全量 2568 passed | 10 skipped（210 文件）；cargo check + cargo test --lib 234 passed / 1 ignored（= E2E 组合器）；`npm run build` 生产构建通过。
- 服务端零改动；生产任务执行链路（task_runner / 计费两阶段 / 队列）原样。

## v4.2.13 对白/气泡/对白导演人工验收残留二轮修复（版本保持 4.2.13）（2026-09-02）

上一轮 V4.2.13（文字渲染契约 + 16 气泡库 + AI 对白导演）13 门 × 3 轮 loop PASS 后的最终复核：4 只读审计确认主链闭环，仅修 10 项真实残留（S1~S10，docs/ai-comic/26 §七）。全程 0 次真实 Image2，鸭梨山大资产未触碰：

- S1 · 图库最终页 composeKey 对白签名补 `fontStyle.color / strokeStyle / shadow`——此前只改这三类字段不触发重组合，与 ComicFinalPreview 签名覆盖面对齐（WYSIWYG 契约）。
- S2 · 「重写本格」P0：apply 的 overwrite 此前仅整页模式传递 → 目标格必有旧对白被 fill 铁律整格跳过，建议永远应用不上且无任何反馈。现 panel 模式草稿限定目标格 + overwrite=true + 弹窗提示行「将替换第 N 格的现有对白」；页面层消费 `applyDialogueDrafts` summary（added / replacedPanels / skippedPanels 如实 toast，added=0 明确报错，根除静默失败）。
- S3 · `applyVisionPlacement` 不再把 manual 对白标记改写为 vision（Story Lock：人工出身最高优先，视觉摆放只挪位置）。
- S4 · 故事重新确认时 toast 明示「N 格分镜已归档，M 条人工/AI 对白一并归档」（`StoryApplyResult.archivedDialogues`），旧代对白不再静默淘汰。
- S6/S7 · 对白字数上限落解析层（`slice(0, maxChars)` = UI 所选 16/24/32，不再固定 60）；planner prompt 增「你只写对白：不得改写故事剧情、节拍或结尾，不得发明输入之外的新情节与新角色」铁律。
- S8/S10 · conformance 守卫补 `.comic-bubble-picker-card / .comic-dialogue-chip` focus-visible 锁；气泡底色抽 `BUBBLE_SURFACE_COLORS` 共享常量（bubbleShape.ts）+ 守卫测试锁 ComicStudio.css 值防 canvas/CSS 漂移；删死变量 tailFixed；3 处注释漂移（ComicLayoutPreview → ComicFormPreviewMini）。
- 加固 · ComicStoryStage 挂载恢复 storyDraft 补指纹校验（与 ComicStoryboardStage 同防线，旧故事草稿不复活）。
- 验证：新增 `comicPlannerDialogue.test.ts` 6 例（解析/白名单回退/repair/maxChars/fill·panel 过滤，mock runAgentRequest 全链）+ dialogueDirector 补 2 例（panel 范围替换 / manual 标记保留）；focused 128/128、vitest 2539 passed | 10 skipped（207 文件）、cargo 234/234（+1 ignored）、typecheck/build 通过；loop 13 门 × 3 轮 PASS（.claude/loop.md §三十五）。

## v4.2.13 AI 漫画文字层几何 P0 Hotfix（AI Comic Text Geometry Hotfix）（2026-09-02）

用户升级 V4.2.12 后打开真实旧项目《鸭梨山大 · 第一期》，页面立即出现一个巨大对白气泡、几乎覆盖整个应用窗口（含侧栏）。只读 app.db 三层几何对照（raw DB → normalize → renderer）定位根因（docs/ai-comic/25 审计全文）——**不是任何一条持久化对白的几何坏了**：

- A · 巨大气泡根因（Picker 内联 SVG 逃逸 viewport）：Text Stage 自动选中第一条对白 → Inspector 挂载 `BubbleStylePicker` → 内联 `ComicBubbleBox` 被 Picker CSS 覆写回 `position: static`，而内部 `.comic-bubble-svg` 是 `absolute + inset:0 + 100%×100%`，且卡片到 `.app` 的祖先链全部 static → SVG 包含块上浮到初始包含块（viewport），六张预览卡把气泡 path 非等比拉伸铺满整个应用窗口。修复：inline 帧自带定位上下文（`is-inline` → `position:relative`，SVG 永远锚定自己的盒）+ `.comic-bubble-picker-preview` 同护栏双保险 + 删除 static 覆写。
- B · Legacy 气泡几何迁移（§7-§10）：新 `normalizeLegacyComicDialogueGeometry`——位置 `>1` 视为百分比刻度证据（归一化域不可能超 1）→ `/100` 再夹 0..1；宽高任一 `>1`（px/异刻度）且无换算依据（旧 schema 未存 panel 像素尺寸）→ 整体丢弃 size 回内容自适应，**绝不钳成 1.0 变整格气泡**（旧 `normalizeDialogueSize` 会把 px 320 钳成 1.0 = 覆盖整格）；NaN/Infinity → 位置回 0.5、size 回 undefined。
- C · Geometry Contract 单源：`COMIC_DIALOGUE_SIZE_RANGE`（0.14..0.92）常量收口——normalize（持久化契约）/ textLayer（画布 resize）/ 渲染 sanitize 三处同域，不再 0.1..1 与 0.14..0.92 两套。
- D · Renderer 最后防线（§12/§13）：`sanitizeBubbleGeometry`（finite 校验 + x/y 夹 0..1 + 宽高夹安全域）在 `ComicBubbleBox`（DOM）与 `comicExport.drawDialogue`（导出/最终页合成）两处渲染边界生效——坏数据进不了 DOM/canvas，一个 Bubble 物理上不可能覆盖整格/整页。
- E · 打开 ≠ 保存（§14/§15）：`openProject` 原先把 normalize 后文档立即整体写回 DB（未来含 migration 会静默改写用户几何）；改为只刷新 lastOpenedAt（原文 JSON 回写），normalize/migration 结果仅存在于内存，用户真正编辑（updateActive）后才落库。
- F · 护栏盘点（§23-§25/§35）：画布 `.comic-editor-figure` overflow:hidden 保留为独立 clip 护栏；气泡族 z-index ≤ 5，App Modal(1000)/Toast(9999)/页内 sticky(60) 均高于气泡——气泡不可能盖侧栏/弹窗/Toast。
- 边界：零 Image2 / 零 GUI 启动；《鸭梨山大》4 张 Panel 与 Final Page 未触碰；Story/Character/Storyboard/FontSelect 未重构；V4.2.12 的 0.42/0.3 位置修复（normalizeUnitFloat）回归保持。
- 验证：新增 duckpear 真实几何 fixture（5 条 raw 对白逐字移植）+ `textGeometryV4213.test.ts` 全 20 项（持久化 / 缺省迁移 / 百分比迁移 / px 迁移 / 巨值·NaN·Infinity sanitize / 画布 clip / 喊话·思考·旁白·无气泡有界 / z-index / V4.2.11 与 V4.2.12 fixture 打开安全）；typecheck + vitest + cargo + build 全量通过；Loop 3 轮见 .claude/loop.md。

## v4.2.12 AI 漫画文字气泡 / 分镜时序 / 场景表现专项收口（AI Comic Text & Storyboard Polish）（2026-09-02）

V4.2.11 全链路收口后的三项人工验收问题根治：对白气泡只能下拉选文字、分镜顺序被任务完成顺序劫持、面板背景接近纯色空白（docs/ai-comic/22 审计 + 23/24 设计）。全程零 Image2 调用（文字层与图片层分离铁律不变）：

- A · 共享气泡几何层（§12/§22）：新模块 `bubbleShape.ts`——七类气泡（经典对白 rounded / 圆润对白 soft / 思考气泡 cloud / 旁白框 box / 喊话 spiky / 低声 whisper / 无气泡文字 none）全部由单一 SVG path 字符串派生，Picker 预览（DOM `<path d>`）/ 画布 / 导出（`new Path2D(d)`）三处同源；尾巴规则（box/spiky/none 无尾、显式四向、auto 按位置象限确定性解析）与 `dialogueFontStack` 统一 fallback 链（'Microsoft YaHei', 'SimHei', sans-serif）同模块收口。
- B · 画布直接编辑（§5~§10）：ComicTextStage 气泡画布化——工具栏三按钮（对白气泡 / 旁白框 / 无气泡文字）点选即放置（newDialogueDraft 安全顶部泳道），点选即选中、拖动即移动（pointer 归一化坐标 + clampDialoguePosition 0.06..0.94 边界）、四角手柄缩放（clampDialogueSize）、Esc 取消、双击进 Inspector 文本框；对白增删改全走 upsertDialogue / removeDialogue 纯文字层（panels 数组引用不变可测），删除可 toast 撤销；Inspector 降为辅助（水平/垂直滑杆收进「精确位置（高级）」，新增「恢复内容自适应尺寸」）。
- C · 气泡视觉选择器（§15/§16）：`BubbleStylePicker` 七卡 radiogroup，每卡内嵌真实迷你 ComicBubbleBox 预览（复用共享几何，无第二套形状实现），切换即时重画画布；尾巴方向选择对无尾样式禁用并说明（旁白框 / 喊话 / 无气泡文字没有尾巴）。
- D · 字体选择器全局修复（§31~§37）：新共享组件 `src/components/FontSelect.tsx`（消灭第 4 处重复实现）——本地字体注册表（中文名 · 示例文字，option 内联 fontFamily 下拉即预览）；受控 select 永不空白：未知字体（旧项目/换机器）追加「原名（不可用）」回退项并被选中；缺省项「默认（跟随导出样式）」onChange 回传 undefined 不写空串。
- E · 分镜顺序完整性 P0（§38~§46）：排版顺序唯一事实 = `panel.order`（comicPanelsByOrder 全渲染点统一入口，stale 副本永不入场）；`applyComicTaskResults` 按 batch_items[].variables.panelId 绑定回写（任务完成顺序 3,1,4,2 回放 → Composer 布局仍 1,2,3,4 阅读序，不串图）；分镜卡新增上移/下移（moveProjectPanel 只交换相邻两格 order——id / 对白 panelId / imageAsset / compiledPrompt / stale 全不动，边界 no-op 返回原引用）+ 提示「调整分镜顺序只会改变漫画排版顺序，不会重新生成图片」。
- F · 场景表现注入（§47~§63）：分镜卡新增 背景 / 时间 字段（time 进 ComicPanel）；promptCompiler 新增「场景与环境（强制）」段——background 为空时兜底「依据画面事件布置明确的故事场景背景（不是纯色或空白）」；sceneRichness 三档（简洁/标准/丰富，缺省标准「陈设简化但不空」）；同场景跨格声明「背景陈设与光线在格间保持连续一致」；贴纸/立绘/纯背景画风豁免；negative 新增背景防线（纯色背景/空白背景/背景空无一物/背景额外新增主要角色）；单格铁律与无字底图铁律原样保留（对白文本永不进图片 Prompt）。
- G · 多页 Preview 统一（§64~§68）：所有形式卡统一 ComicFormPreviewMini——多页 = 堆叠页 +「+N 页」角标（preview 内不渲染「第 N 页」文字标签，根除重叠错位）；多页卡 meta「N 页 · 每页 1 张 · 共 N 张成品图」、单页卡「格」。
- H · 持久化兼容 P0 修复（§79/§80）：`normalizeComicDialogue.position` 误用整数归一化（Math.round）——0.42/0.3 这类归一化坐标重开项目后被抹成 0/1（气泡全部跳到格角）；改 `normalizeUnitFloat` 只夹 0..1 不取整；V4.2.11 旧数据（无 tail/size/family）归一化补默认（tail:'auto'）不丢对白。
- 边界：零 Image2 / 计费 / 服务端 / 任务链路改动；《鸭梨山大 · 第一期》已生成的 4 张 Panel 与 Final Page 未受任何触碰（duckPearV4212Regression 以内嵌 fixture 回放验证兼容）。
- 验证：新增 8 个测试文件 93 用例（bubbleShape / panelOrder 完成顺序回放 / promptScene 三档与豁免 / 气泡画布 SSR 渲染 / FontSelect / 多页 Preview / TextStage 接线 / 鸭梨山大 V4.2.11 形状回归）；vitest 2469/2479（10 个 V4.2.11 E2E gated 跳过）+ cargo 234/234 + typecheck / build 通过。

## v4.2.11 AI 漫画完整工作流收口（AI Comic Workflow Convergence）（2026-09-02）

把 AI 漫画从「各步骤能各自点」收口为「故事一路做到最终漫画成品」的完整创作产品（docs/ai-comic/19 审计 + 20 设计；真实项目《鸭梨山大 · 第一期》全链路验证见 docs/ai-comic/21）：

- A · 角色身份去重（P0）：新模块 `characterIdentity.ts`——`characterNameBase`（剥身份后缀/全半角/空白）+ `characterIdentitiesMatch`（characterKey 相等优先，键缺失退化净名全等；`鸭妈妈` ≠ `鸭老师` 绝不模糊合并）+ `dedupeComicProjectCast`（打开项目与规划落库双侧归并：保必选槽、迁移绑定、清 concept-N 复制槽）；planner 概念并入按 key 匹配，槽位/快照 characterKey 双写。同名重复演员从根上不可能（§153-1）。
- B · 异步参考图任务（P0）：删除 ComicStudio 全局 taskRunning 提交互斥——参考图按角色独立状态机（ref_queued/ref_running/ref_failed/ref_completed），同角色在途去重 toast；A 运行不阻塞 B 提交（§79~§96），队列仍是 Rust 单 worker 串行执行。
- C · 演员阵容 UX V2：横向演员条 + 紧凑角色卡（状态徽标/参考图缩略/锁定标记），锁定态直观呈现 locked + referenceImage（§153-3 UI 面）。
- D · 动态工作流：用户步骤由 Presentation（outputMode）派生——故事 → 画面与形式 → 角色演员 → 分镜草稿 → 生成漫画画面（single_page）/生成漫画页面（multi_page）→ 对白与字幕；anchor/panels 内部枚举与 ComicExecutionMarker 追溯保留，旧 stage=anchor_* 映射不崩溃；锚点不再暴露为用户步骤。
- E · 分镜直排版：分镜步骤主呈现 = Presentation 几何网格（四格 2×2/九格 3×3/多页分组），每格即分镜卡（只 Patch 本格），空态「等待规划」占位格；0 格大空白单预览形态消失（§153-4/5）。
- F · 单页生成编排 + 最终页组合：`buildPanelSeriesTask(skipAnchor)` 一次性全量提交（variables.panelId + 编译期冻结 source_images + freezeCompiledPrompt）；格 prompt 单格铁律（含 `单格画面`，禁 四宫格/2×2/宫格拼图 排版指令）；`computePageLayouts`（1080×1440 / gap 24 / cover-crop）→ 组合最终页；`applyComicFinalPages` 组合页入项目 finalPages + 图库归档（tags ai-comic/comic-final-page/projectId）；`upsertDialogue` 对白编辑纯文字层零 Image2（§153-9）。
- G · 真实 E2E（§79~§127）：《鸭梨山大 · 第一期》真实项目 10 阶段 gated 测试 `duckPearE2E.test.ts`（V4211_E2E=1 才跑，默认跳过）——boot 凭据/演员去重/异步参考证据/分镜定稿（真实 planner 或 §125 如实 BLOCKED）/系列任务构建（锁定小圆鸭参考真实入槽）/真实计费 quote→authorize→edits×4→settle（失败全额退，绝不悬挂预占）/生产回写/Rust 等价组合最终页/对白编辑零生图重组合/落库重载还原。配套 `__e2e__/db_helper.py`（app.db kv 权威 + 旧 json 双写）与 `__e2e__/image2_helper.py`（packyapi 边缘按 TLS 指纹过滤 Node undici，生产为 reqwest/SChannel；Python urllib 承担 + 多路由候选，multipart 与 task_runner 1:1）+ `e2e_compose.rs`（#[ignore] Rust 组合器，几何由 computePageLayouts 下发，§89 布局单一事实源不破）。
- 边界：零服务端改动；生产任务执行链路（task_runner/计费两阶段/队列）原样。
- 验证：vitest 2374/2384（10 个 E2E gated 跳过）+ cargo 234/234 + typecheck / build 通过；真实 E2E 证据 target/e2e-v4211/duck-pear-evidence.json。

## v4.2.10 AI 漫画「角色演员」页面紧急 UI 收口（2026-09-02）

V4.2.9 人工验收不合格的角色演员（Character Stage）页面整体重构——只改页面结构 / 信息架构 / 视觉层级 / 操作路径，零业务链路改动（docs/ai-comic/18 审计先行，Planner / Image2 / Billing / 演员库 / Snapshot / Story / Storyboard 全部原样）：

- 前置审计（docs/ai-comic/18-CHARACTER-STAGE-UI-AUDIT.md）：先明确真实结构再动手——参考图弱 = 132px 网格列与 172px 固定宽两代 CSS 冲突（实际 ~13-16% vs 目标 25-30%）+ `.comic-ref-actions .app-btn-sm { width:100% }` 把 CTA 拉成紫色横条 + 图不可点击放大；锁定层级混乱 = 「确认并锁定 / 仅本项目锁定」两个并列按钮同一门禁只差是否入库。
- 演员阵容总览（§3）：顶部新增「本期演员阵容」卡——roster 行（每角色小头像 + 槽位 + 统一徽标）+ 必选 X/Y 已完成 / 可选 X/Y / 已锁定计数 + 未就绪「还需要完成：」逐条 blockers / 就绪「演员已就绪」，首屏即知全员与下一步；步骤 blockers 横条职责并入。
- 必选 / 可选分区 + 2 列网格（§15）：required 槽位 2 列 responsive grid（≤1100px 单列），不再纵向全宽堆叠；可选未绑定 = Compact Add Card（AI 起草 / 从演员库选择）。
- Reference Surface 四态（§5/§6）：参考图列固定 148px（≈半宽卡 30%，视觉中心，删除固定 172px 溢出写法与 width:100% 横条规则）——空态（暂无角色参考图 + 区域内 [生成参考图] Primary + 从演员库选择 / 从图库选择 / 上传参考图）/ 生成中（正在生成角色参考图 · 任务已提交，进度见任务队列，真实任务事实）/ 失败（原位重试）/ 成图（点击进全局 ImageViewer，查看器自读大图，组件只传 path）。
- 统一状态徽标（§7）：草稿 / 待生成参考图 / 参考图生成中 / 待确认 / 已锁定 / 需要重新生成 / 失败——全部出自 comicCharactersSummaryState 单一事实源（排队并入「参考图生成中」徽标、blocker 保留排队事实；ready/confirmed 统一「待确认」），组件不自拼状态文字。
- 锁定单 Primary + 入库复选项（§8/§9/§10）：删除并列双按钮，改单一 [确认并锁定] + 复选项「保存到演员库，方便以后复用」（默认勾选，helper「不勾选则仅本项目锁定（不进演员库）」）；缺参考图 disabled + 卡内原位原因（domain 常量 + lockComicCharacter 双保险不变）；锁定去向两态回显「已锁定 · 已保存演员库 / 已锁定 · 仅本项目」。
- 锁定折叠（§24/§25）：锁定成功默认收起为 Compact 卡（缩略 + 名字 + 一句话 + [编辑角色] 展开）；draft / 生成中 / 缺图锁定异常保持展开；解锁 = 回到待确认并保持展开。
- 信息分层（§11/§12）：默认只有名字 / 定位 / 一句话设定 + 特征计数（固定特征 N 项 · 可变特征 M 项）；外观 Prompt / 跨格不变 / 可变 / 默认服装 / 禁止全部收进「查看角色设定详情」原生 details 折叠（默认关闭）；大白话微调（textarea + 应用调整 + inline error）原样保留。
- Right Rail（§Rail）：阵容计数行（已锁定 X/Y）+ 每角色小头像 chips（有图缩略 / 缺图首字占位 / 锁定态主色描边）；Rail summaryLabel 单一事实源锚点保留。
- UI Skill 合规：全部按钮 app-btn 家族；新自定义控件 comic-ref-view（点击放大）进 conformance 白名单 + :focus-visible 同规范焦点；颜色全部 var(--*) 令牌；copy.md §2a 登记 V4.2.10 术语（本期演员阵容 / 必选演员 / 可选演员 / 演员已就绪 / 状态词表 / 复选项 / 折叠等 14 行，并修正 确认并锁定 / 仅本项目锁定 两行过时语义）。
- 验证：新增 comicCastV4210 32 用例（16 项验收场景 + 词表回归）；comicPhase11 状态矩阵 / comicPhase11Wiring 锁定门禁 / comicPhase12ActorLibrary 锁定模式锚点随规范更新；vitest 全量 + cargo + typecheck + build 通过。

## v4.2.9 AI 漫画规划反馈与故事审定 UI 收口（2026-09-02）

V4.2.8 人工验收 4 项 GUI 问题的根因修复（docs/ai-comic/17 审计：规划体验居中化 + multi-page 小卡片布局 + 故事审定信息层级）：

- 「多页连载」小卡片布局损坏根因修复（§1.3）：三因叠加（各卡各自 max-width 补丁 / 页标签 absolute nowrap 文字比 40px 页框宽 / flex-wrap 容器超宽换行）。新建 `ComicFormPreviewMini` 统一 72×96 固定画布（overflow hidden）——单页形式画布内一页框 + 格子网格（columns 由 resolveConceptPresentation 单点派生）；多页形式画布内两张重叠页（前页 + 右下偏移半透明后页）+「+N 页」角标，preview 内不再渲染「第 N 页」文字标签（页数细节由卡正文短说明承载）；删除旧 per-card max-width 补丁，无任何 transform: scale() 糊弄。
- AIPlanningSurface 统一规划状态面（§二/§三）：ComicPlannerProgressCard 演进为唯一实现（组件删除）。运行中 = 内容舞台居中卡（min(560px,100%)）：标题 + 场景语义副文案 + 阶段清单（✓ 已完成 / ● 当前 / ○ 待执行，真实管道边界 resolving → planning → validating；retrying 是 planning 的回退事件显示在状态行）+ 真实 resolved 模型名 + 已用时秒数（每秒真实计时）；失败原位错误 + 重试 + 返回；角色/分镜卡内嵌场景走 inline 档（width:100% 不居中）。
- 百分比整体移除（Progress Honesty V4.2.9 裁定）：审计确认「40%」来自 COMIC_PLANNER_STAGE_PERCENT 阶段锚点派生（非 timer 伪造），但规划是单次 LLM 调用，阶段锚点百分比会被读成真实生成进度 → COMIC_PLANNER_STAGE_PERCENT / deriveComicPlannerPercent 删除，等待感由阶段清单 + 真实计时 + 不确定态动画表达；prefers-reduced-motion 降级。
- 推荐弹窗两段规划居中（§四）：「推荐漫画方案」与「使用这个故事 → AI 起草技能」运行中，输入表单原位替换为 Planning Surface + 顶部需求摘要条（你的要求 / 漫画形式；已选故事），不再沉在 Modal 内容最底部——用户无需滚动即知 AI 已开始；失败「重新推荐 / 重新起草 + 返回修改需求 / 返回选择故事」，输入与已选方案全部保留（V4.2.8 状态规则不变）。
- 本期故事规划居中 + Replan 红线（§55）：Step 1 规划中同样进居中 Planning Surface + 本期需求摘要；重新规划时旧 Story 不清空——已有故事时上方保留淡化 Hero 卡（opacity 0.55 / pointer-events none，kicker 明示「正在重新规划，失败后仍可返回使用」），失败后返回表单仍可回当前故事；规划输入不回退。
- 故事审定 Story Hero 重设计（§六）：从 dl 字段详情页改为——kicker（故事审定 · 请确认本期故事）→ 标题（20px heading）→ 形式/格数/主题 chips → 概要（62ch 可读宽度）→ 节拍可视化网格（列数与展示形式几何同源：四宫格 2×2、九宫格 3×3、竖排/多页 1 列，序号圆徽 + 每拍一卡，不再 join 成连续长文本）→ 结尾 Punchline callout（结尾类型徽标 + 最后一拍，accent 左边线）→ 涉及角色 chips → 按钮区（确认这个故事 = 唯一 Primary，重新描述 secondary）；已确认 Hero 卡复用同一 storyBody 单实现。
- 边界：零 Image2 / 生图 / 计费 / 系列 / 文字层 / 演员库改动；推荐约束（fixed/auto）、Concept Transfer、Storyboard Preview、GLM-5.3 structured parsing、定向修复重试、草稿保持全部原样。
- 验证：新增 comicPlanningV429 22 用例（multi-page 根因 / 无百分比 / 居中集成 / 审定层级 / Replan 红线）+ comicPhase11 / comicPhase11Wiring 锚点更新；vitest 2301/2301（191 文件）+ cargo 234/234 + typecheck / build 通过；loop.md V4.2.9 Gate 实跑 3 轮全 PASS。

## v4.2.8 AI 漫画创意入口与推荐体验完整重构（2026-09-02）

「新建漫画项目」入口与推荐体验按 V4.2.8 规格整体重构（docs/ai-comic/15 审计 + 16 设计）：

- 漫画形式选择器（§4~§11）：输入页新增可视化小卡选择器（radiogroup，非 Select/Chip）——[AI 自动]（SVG 星形示意，不用新 Emoji）+ 全部 7 个真实模板（四宫格/九宫格/上下双格/左右双格/三格竖版/单幅/多页连载，各自带 ComicLayoutPreview 几何缩略 + 名称 +「1 页 · 4 格」短说明）；下方「当前选择」即时反馈块动态解释 fixed（三方案都保持该形式）/ auto（AI 分别选形式）语义。
- auto / fixed 约束三层契约（§13~§22）：fixed = 硬约束——Prompt 追加最高优先级硬约束块、user content 携带结构化 constraint JSON（禁止「请用四格」式自然语言拼接）、Validator 硬校验（arrangement / panelCount / multi_page pageCount / storyboardBeats 恰好每格一拍）、违反 → repair 轮以「用户明确选择「四宫格」…不允许修改漫画形式」前言定向修复，仍违反 → 报错不静默接受；auto = AI 自由 + 三方案形式尽量有差异 + 同形式下故事必须真正不同（§57~§59）。约束随 recommendation 请求同 requestId 传递，重试保持约束。
- 状态规则（§18~§22）：形式约束独立于需求文本——编辑需求、失败重试、「换个需求」都不重置约束（只在弹窗重新打开时回到 AI 自动）；概念切换不重发 planner 请求；重新推荐 = 新 requestId 同约束。
- Story-first 结果页（§25~§47）：方案切换器从文字分段改为 3 张 Mini Concept Card（几何小图 + 方案N + 故事标题 + 形式行 + 基调行，tab 语义保留）；主区顺序 = 故事标题 → 一句话 → 故事分镜预演 → 包袱 → 角色（徽标族 chips）→ 形式元信息（含「预计 N 张图片」）→ [使用这个故事]（唯一 primary CTA）→ 完整故事（默认折叠，secondary-sm 展开）→ 创作详情（折叠）；切换方案 / 阶段时主区回滚顶部。
- ComicStoryPreview「格子即 Beat」（§30~§38）：新组件把分镜节拍直接渲染进格子（序号 + 短标题 + 概要；≥6 格紧凑档概要走悬浮），单格渲染为场景卡（标题/概要/分隔线/结尾包袱，不再是空白矩形），多页渲染真实页帧（每页一帧 + 页标签 +「N 页 · 每页 1 格 · 共 N 格」，超出折叠 +N 页）；几何全部来自 resolveConceptPresentation 单点，纯 CSS/DOM、零 Image2 调用、零计费。
- Concept Transfer 契约（§49~§57）：项目持久化 presentationSource（user_fixed / ai_recommended）——用户在入口固定的形式随后续对话式微调不可改排版（guardComicPatchesAgainstPresentationLock 过滤 layout 补丁并 toast 明示唯一入口是 Step 2 形式选择卡；显式选择卡刷新 user_fixed 基线）；concept.characters 确定性并入 characterSlots（LLM 槽位保留、缺失角色按序追加、无必选槽位时优先提升 concept 角色兜底）。
- UI Skill 合规：新自定义控件 comic-form-selector-card / comic-concept-mini 进 conformance 白名单 + :focus-visible 同规范焦点；全部颜色走 var(--*) 令牌；进度卡保持真实模型名与真实阶段（resolving/planning/validating/retrying），无伪造阶段或百分比。
- 边界（§81~§85）：零 Image2 / 生图链路改动、零计费改动、零系列 / 文字层改动。
- 验证：vitest 2280/2280（comicPlanner 新增 V4.2.8 约束/多样性/角色槽位 16 用例 + 新增 comicRecommendationV428 29 用例 + conformance 白名单扩展）+ cargo 234/234 + typecheck / build 通过。

## v4.2.7 AI 漫画推荐结构化返回 P0 修复（2026-09-02）

「推荐漫画方案」报「AI 未按结构化格式返回结果」的根因修复（docs/ai-comic/06 D-111）——真实复现捕获实证：GLM-5.3（reasoning 模型）在缺省 max_tokens=4096 下 reasoning 与正文共享预算，finish_reason=length、JSON 在 concepts[1] 中途截断，结构化解析必然失败；非 Schema 不匹配、非 UI 问题：

- 统一 AITransport 增 per-request 输出预算：run_agent_request 接受可选 max_tokens（缺省 4096、钳 1024~16384，chat/responses 三处 body 统一生效），并透传 finish_reason；finish_reason=length 时打 [ChatTransport] 截断日志。comicPlanner 大 JSON 调用（方案推荐 / 技能起草 / 故事与分镜规划）显式传 8192，补丁与单角色维持缺省——不为 Comic 单写 HTTP client，其他调用方零影响。
- 定向修复重试：解析 / 校验失败自动重试 1 次（initial + repair = 2 次），第二次把首次具体失败原因（截断 / JSON 解析错误 / 校验问题清单）转成修复指令追加到请求，要求保持故事内容只修结构；错误按「过长被截断 / 格式异常」分类大白话提示。
- 可诊断日志：每用户动作一个 requestId，attempt 与各阶段（request/reply/extract/validate）开发诊断日志（仅 Development，Production 静默；不含任何 API Key / Authorization / Base URL）；弹窗推荐与技能起草加 useRef 同步双击防护，失败不清空需求输入。
- 解析有限容错（Schema 严格度不降）：Markdown fence、JSON 前后解释文字、characters / storyboardBeats 的 string[] 形态、旧响应 legacy presentation 字段忽略（展示形式仍由 layout 派生）；新增「所有方案都完全没有故事」拦截——不静默 PASS、不复制凑数、不造假数据。
- 真实回归 fixtures：comicPlanner.fixtures.ts 由真实调用捕获程序化生成（截断根因样本 1263 字符 + 完整基准 3541 字符，修改 = 伪造测试数据，禁止）。
- 验证：vitest 2239/2239（comicPlanner 31 用例 + comicRecommendationStoryFirst 18 用例）+ cargo 234/234 + typecheck / build 通过；真实模型复验（小鸭子冷笑话）：finish_reason=stop、3 个方案各有完整故事（177/202/184 字）/ 布局 / 节拍 / 角色，其中 completion=5164 tokens 实证旧 4096 预算必截断。

## v4.2.7 推荐方案 Story-first 可视化专项（2026-09-02）

AI 漫画「新建项目 → AI 推荐」重做：从文字参数列表变成真正可选的漫画故事选择器（docs/ai-comic/02 §3 + D-110）：

- 根因修复：推荐卡"文字多却没有完整故事"= schema 本身没有故事字段 + Prompt 要求配方而非故事 + UI 默认铺开规划字段；"Presentation 只有文字" = ComicLayoutPreview 组件存在但未接推荐卡 + arrangement 白名单只放行 4 值。
- 每个推荐方案先讲一个完整故事：故事标题、一句话故事（≤40字）、完整故事（80~200字）、结尾包袱，再给出节拍预演 storyboardBeats（序号/短标题/概要/角色，长度 = 格数）——规划类字段（视觉方向/剧情结构/对白风格/适用场景）默认折叠进「查看创作详情」。
- 推荐卡可视化：[方案 1/2/3] 分段切换 + 单方案大预览；ComicLayoutPreview 纯 CSS 渲染四宫格 / 九宫格 / 上下双格 / 左右双格 / 竖排三格 / 单幅 / 多页连载七种结构（格内显示序号与节拍短标题，多页显示"N 页 · 每页 1 张 · 共 N 张图"），几何与画面与形式步骤同源计算；推荐阶段零 Image2 调用、零计费。
- 三个方案故事本质不同（Prompt 强制创作顺序：先写完故事，再定角色与包袱，拆节拍，选展示形式，最后才是视觉风格）；旧格式响应自动兼容回落（storyTitle→方案名、一句话→示例笑点、节拍→空）。
- 选中即传递：「使用这个故事」→ AI 起草技能（concept.layout 确定性写入，展示形式所见即所得）→ 创建项目时把完整故事种子进 Step 1「本期故事」审定阶段（可确认 / 大白话修改 / 重新规划），创建预览页回顾所选故事与排版。
- 验证：vitest 2225/2225（新增 comicRecommendationStoryFirst 12 用例 + comicPlanner Story-first 形状/旧响应兼容/Prompt 顺序/确定性 layout 覆盖）；typecheck / build 通过；推荐链路不动 Image2/角色/系列/计费业务。

## v4.2.7（2026-09-02）

AI 漫画 UI System 收口（V4.2.7 UI Convergence，docs/ai-comic/13 审计 + 14 验收表）：

- 根因修复：漫画模块 57 个操作按钮全部只写 variant 类（`app-btn-primary` 等）而漏了 `app-btn` 基类——App.css 中 padding/圆角/边框/字重/hover/disabled 全挂在基类上，导致整个模块按钮退化成「浏览器默认样式 + 一层背景色」（GUI 验收看到的默认按钮感 / 小红框删除的来源）；本次全部补齐基类，视觉与技能工坊/图像工坊完全一致。
- 清零不存在的 `app-btn-ghost`：App.css 从未定义该类，模块内 6 处 + 技能工坊弹窗 2 处「关闭」按项目惯例统一改 `app-btn app-btn-secondary`（弱操作一律 secondary）。
- Tab/Chip 迁移共享组件：新建项目弹窗「AI 起草/从技能库」与演员库分类过滤（全部/AI 创建/上传/图库）由自建 pill 皮肤（comic-tab/comic-chip）迁移为项目标准 `app-segmented`（含 aria-pressed 键盘可达），删除对应自建 CSS。
- 键盘焦点补齐（设计系统扩展）：App.css 为 `.app-btn` 共享按钮族补 `:focus-visible`（与 `.app-segmented-btn` 同规范 2px 主色 outline）；漫画白名单自定义交互控件（步骤栏/项目卡/选择卡/分镜缩略/弹窗关闭）在各自 CSS 补同规范焦点环。
- 守卫纠偏：`comicPhase11Wiring` §十四旧正则曾把「缺基类 + 幽灵 variant」锁成规范（根因共犯），重写为「app-btn 基类 + 恰一个真实 variant + 禁止 ghost」；`comicPhase12UiSkill` 弹窗断言改为锁定 app-segmented 迁移；新增 `comicUiConformance` 守卫（raw button 白名单清零 / variant 缺基类清零 / 删除动作必须 danger / 操作行同时可见 primary ≤1 含条件互斥判定 / CSS 零按钮皮肤零自建 tab-chip / 焦点环存在性）。
- 边界：零业务逻辑改动（onClick、quote→authorize→task→settle、防重、草稿保持全部原样）；选择卡/步骤栏/弹窗关闭为规格允许的漫画自有 layout，仅令牌化核验不强套 app-btn。

## v4.2.6（2026-09-02）

AI 漫画 Phase 1.2 —— 工作流与 UI 重做（Story-first / 演员库 / 状态保持 / 单格生成语义）：

- 工作流重排为用户语言七步：本期故事 → 画面与形式 → 角色演员 → 分镜草稿 → 第一张效果 → 生成剩余图片 → 对白与字幕（内部枚举全兼容，只是映射改名）；第一步只确认故事，分镜移到第四步生成；顶部与右侧栏由单一事实源汇总"这期讲什么"。
- 修复每张分镜图里又画四宫格：分镜 Prompt 不再携带"四格漫画"等页面级形式词（标题只保留技能名、模板占位符恒空），并加入单格画面强制指令与多格拼图负面防线；生成单元 = 一格。
- 演员库闭环：角色锁定后可一键保存入库，库弹窗支持分类（全部/AI 创建/上传/图库）、搜索、缩略图、来源与最近使用；空态提供 AI 创建/从图库添加/上传/保存当前角色四个动作；从库选择为深拷贝快照，引用即计数。
- 切步骤 / 刷新 / 关闭重开状态全保持：故事草稿、分镜草稿、单格微调输入、角色微调输入四类草稿随项目持久化，挂载自动恢复（六组步骤往返矩阵 + 七段重开恢复由集成测试锁定）。
- 画面与形式可视化选择：四宫格/九宫格/上下双格/左右双格/三格竖版/单幅/多页连载七种模板带格位示意（2×2、3×3 等实时预览），选择卡、右栏、分镜页与最终组页共用同一几何计算。
- 分镜页用户语言重做：每格展示画面/角色/动作/表情/场景/对白概要事实行，支持"只改这一格"大白话微调（白名单字段、同值不生效、改内容清编译缓存、已有图片标记待重出）。
- 生成阶段用户语言重做：「第一张效果」（确认这个效果后解锁剩余）与「生成剩余图片」（进度行、失败格显示失败原因、只重试失败的那几格）；系列完成后新增「最终页面预览」——本地画布按形式自动组页（多页支持翻页），不重新调用生图。
- UI 体系收口：弹窗皮肤抽为共用样式文件（四个漫画弹窗复用），三套状态徽标统一为令牌驱动的单一徽标族，漫画样式零裸色值（作品层导出配色除外）、零按钮皮肤覆写。

## v4.2.5（2026-08-31）

AI 漫画 Phase 1.1 —— GUI 真实验收修复 + 角色参考图闭环：

- 角色参考图生成闭环：每角色可一键生成定妆参考图（单角色/干净背景/完整外观/面部清晰/无字底图铁律），走既有生图链路（报价确认、两段授权、任务队列、结算、图库、历史全继承）；生成中状态由任务事实派生，图库用途显示「角色参考图 · 角色名」，历史溯源行含角色名。
- 角色状态机收口：确认并锁定 = 设定有效 + 参考图齐备 + 用户确认三合一；缺少参考图时按钮禁用并提示「请先生成或选择一张角色参考图」；设定修改后参考图标记过期（「角色设定已修改，参考图需要重新生成」），换新图自动恢复；必选角色必须锁定才放行故事步骤，选配槽位永不阻塞。
- 并行角色起草：每个角色槽位独立起草状态，角色 A 规划中不影响角色 B，各自显示阶段进度与失败重试，无全局遮罩。
- AI 可观测性：AI 推荐、角色起草、故事规划、分镜生成四处置显示真实解析模型名（不硬编码、不暴露密钥）与阶段式进度（解析/规划/校验/重试，失败不渲染进度条、重试百分比诚实回落），失败原位显示并可重试，输入全部保留。
- 新建漫画项目弹窗重做：大白话需求 + 模型预显 + 阶段进度；AI 推荐三张六字段方案卡（漫画形式/视觉方向/剧情结构/角色建议/适用场景/示例笑点）+「使用这个方案」。
- 步骤导航门禁修复：「继续：本期故事」等按钮禁用时逐条列出缺什么（如「主角汤圆：未生成参考图」）；被锁步骤点击弹出原因，不再无反应；角色汇总行（必选 N/M 已锁定 · 待办 K 项）由单一事实源计算。
- 开发模式新增漫画调试面板（阶段/必选/锁定/参考图/每槽状态与任务号），生产构建不渲染。

## v4.2.4（2026-08-29）

Prompt 执行链路与批量同效果：

- 图生图恢复"AI 智能规划"纯文本规划入口，与"视觉理解优化"双入口共存：智能规划有无参考图都可用，视觉理解优化需要至少 1 张参考图片（不可用时按钮禁用并提示原因）。
- 提示词、负面提示词与实际执行提示词在生成前冻结为执行快照：历史记录按快照展示 Prompt 来源、正向、负面与真实发送给模型的完整指令；旧版本任务如实标注"未记录完整执行快照"，不伪造数据。
- 图生图支持负面提示词输入；优化结果、携带方案与手填负面词统一进入执行链路，由生成适配层拼接后真实发送。
- 需求或参考图变化后，此前的优化结果标记为过期：提交时明确提示"当前需求或参考图已变化，建议重新规划"，可选择重新规划或确认用原文生成，不再静默回退。
- 新增"批量同效果生成"：从成功任务创建系列批量（任务队列成功卡、历史详情、批量页"从已有任务导入"三个入口），把来源 Prompt 拆分为固定部分与主题变量槽（如十二生肖），逐项预览、编辑、禁用后批量生成；支持跳过已完成的主题、继承参考图与成功结果图作为系列视觉参考；失败项可单独重试。
- 批量生成支持视觉理解优化总需求与批量负面提示词。

## v4.2.3（2026-08-29）

视觉理解与复刻工作流：

- 修复历史视觉理解项目步骤状态恢复异常：老项目素材替换完成状态按保守策略恢复，素材修改后相关确认自动复位。
- 修复人物替换面板边框与人物参考来源区域布局；服装更改界面简化，支持原图服装、人物服装与自定义三种来源。
- 区域替换正式归入素材替换流程，区域逐项进入复刻优化输入。
- 复刻优化 Prompt 支持人物、风格、服装与区域修改要求，语义修订与优化修订保持对齐。
- Prompt 优化新增阶段进度反馈，按真实阶段展示进度。

技能与社区：

- 恢复“复刻成我的技能”：视觉理解项目可通过 Skill 创作器提取来源事实、AI 通用化并保存到“我的技能”。
- 新增社区 Skill 投稿、样例授权、后台审核与超级管理员发布流程；Skill 通用化使用独立模型角色，来源事实、通用规则、风险检查与公开净化分层展示。
- 技能支持直接生成与方案模板复用，可重放方案快照并同源重建。
- 单张图生图编辑需求支持 `@` 引用真实图片，并显式标注人物、背景、风格与通用参考用途。

界面与图库：

- 项目预览集中展示原图、理解摘要、模型和状态，并提供“重新视觉理解”主入口。
- 人物替换、服装更改、自定义修改内容、详细分析和高级设置支持独立折叠；人物右卡提供图库、本地导入和文字描述三种直接更换入口。
- 输入修改要求后可自动勾选明确维度，用户仍可手动勾选或取消；手动保存移入“更多”，自动保存状态常驻。
- 图库新增文件夹分组；生成支持自定义输出路径。

## v4.2.2（2026-08-27）

### Added

- **技能工坊**：新增独立一级入口，以左侧步骤、中央表单、右侧实时方案组成八步创作向导；向导模式与专业模式共享项目状态，完整 Prompt 默认折叠。
- **专业桌搭 Skill**：首个生产级 Skill 使用 Business Walnut 基线，内置 Business、Minimal、Creator、Gaming、Industrial、Cozy、Cute 风格和无主题、原创可爱、自定义素材主题。
- **素材分析卡**：Logo 必须由用户主动分析并确认；素材 SHA-256 指纹变化会使旧分析失效，生成时携带 Logo 原图并执行禁止变形规则。
- **版本化目录与离线回退**：客户端读取官方 Skill Catalog，支持在线目录、本地缓存与内置专业桌搭回退；电商、产品、品牌广告、室内、运动和 UI 领域只显示测试状态。
- **本地 Skill Project**：项目以版本化 JSON 保存到本机 SQLite，预留账户、远端版本与冲突字段，不启用跨设备同步。
- **主动 AI 质检**：生成后由用户主动触发，输出通过、警告或不通过以及证据；一键修正只创建新提案，重新报价确认后才生成。

### Changed

- Prompt 编译顺序固定为安全与素材限制、已确认素材卡、领域硬规则、用户覆盖、Profiles、Base 和默认值；硬冲突会阻止报价和生成。
- 图片评价不再随任务完成自动调用模型，改为用户主动发起，避免静默消耗。

### Compatibility

- 现有图片生成、视觉理解、AI 智能体和旧模板入口保持不变；旧任务与旧模板数据不迁移、不删除。

## v4.2.1（2026-08-27）

### Fixed

- **宽屏公告连续滚动**：跑马灯根据窗口宽度动态补齐公告副本，窗口缩放后自动重算，消除中段空白和循环断层。
- **试用注册信息统一**：注册弹窗从服务端读取试用开关、赠送 CY 点数和有效天数，不再展示固定 `$1余额` 或虚假的剩余名额。

### Compatibility

- 旧客户端继续使用试用库存接口的 `remaining=0/1` 兼容字段；v4.2.1 改用服务端下发的完整试用策略。

## v4.2.0（2026-08-25）

### Added（CY Credits Billing V1）

- **CY 点数计费体系**：用户侧计费单位统一为 CY 点（¥1 = 100 点，兑换率由服务端统一下发）；钱包三类点数（正式 / 试用 / 赠送）分列展示，消费顺序 试用 → 赠送 → 正式由服务端唯一裁决；旧美元余额仅作兼容镜像，不再作为主展示口径
- **生成前报价确认（Generation Quote）**：所有付费图片生成入口（批量创建 / 图生图 / 图片编辑 / Image Studio / 视觉复刻 / 聊天生图）提交前必须先取服务端报价，全局报价确认弹层展示 模式 / 数量 / 单张 / 预计消耗 / 当前余额 / 生成后预计剩余；「确认生成 · N 点」后按报价冻结价计费（10 分钟有效期）；点数不足时确认按钮禁用并引导充值；客户端全面禁止自行「数量 × 单价」计价
- **生成按钮价格展示**：批量创建页生成按钮显示「开始生成 N 张图片 · 预计 M 点」（数据来自服务端权益接口）
- **任务计费列**：任务卡显示 预计 N 点 → 实际 M 点（部分成功自动显示退回 K 点）；失败释放全链路可见
- **点数充值（人民币直购）**：充值档位 ¥10 / ¥20 / ¥50 / ¥100 + 自定义人民币金额，实时显示「预计获得 N 点」；微信扫码支付到账 +N 点；订单查询显示到账点数
- **点数流水**：我的账户新增「点数流水」——充值 / 图片生成 / 生成退款 / 充值退款 / 试用赠送 / 余额迁移，方向一目了然（正 = 入账、负 = 消费）
- **新用户试用一次性领取（Trial Entitlement）**：入口仅当服务端 trial_available=true 时显示；同邮箱一生仅可领取一次（服务端 claim ledger 判定，删除账号重注册不可重复领取）；成功即到账试用点数
- **扣费标准点数化**：扣费标准弹窗与费目明细全部以点数展示（旧美元口径仅历史数据回退显示）

### Added（视觉项目工作台 / Runtime Skills / 一致性体系）

- **视觉项目工作台（Visual Projects，ADR-016）**：视觉理解页升级为可持久化的项目工作区--保存项目 / 恢复项目 / 重命名 / 复制 / 基于此方案新建 / 删除（应用内确认弹窗 + 确认态整体替换操作区）；项目库「查看全部项目」（筛选 全部 / 最近使用 / 已理解 / 已修改 / 已生成 + 项目卡缩略图）；重开项目直接显示既有分析结果（分析状态 canonical 收口到项目文档，绝不重调分析 API）；项目索引恢复命令（rebuild_visual_project_index，修复摘要列漂移不删行）
- **Runtime Skill Engine（ADR-022）**：Contract 系统升级为可解释执行层--15 个内置技能（分析 / 约束 / 优化 / 编译四类，注册表带 priority + dependsOn 依赖拓扑，执行顺序派生且受测试守护）；Skill Trace 五阶段呈现（发现 / 建议 / 用户选择 / 系统强制 / Prompt 写入），快照双冻结（优化完成 -> 项目、生成时刻 -> provenance，History 只读冻结态，旧任务如实标注「无技能记录」）；「AI 技能中心」（核心技能始终启用无假开关，可停用技能具有真实编译门控效果）；执行过程一键复制 / Markdown 导出（buildSkillTraceMarkdown：头部元信息 + 每技能五阶段 + 最终 Prompt 分段附录）
- **维度锁定合同（ADR-019 / ADR-020）**：locked / modified 二态语义（未选维度 = 锁定，LOCKED ≠ 尽量沿用）；TemplateSnapshot 逐主体姿态 / 朝向 / 归一化锚点（混合媒介真人层与动漫层分别锁定，构图恒锁）；优化器越权结构化清洗（optimizerViolations + Toast 可见）+ 正文级守卫（lockedDimensionGuard 动作 / 镜头词库句级拦截，基线含词豁免）；生成前 validateDimensionLockContract 并入 blockingErrors 双门禁；优化快照自动恢复（optimizationHistory 上限 8 + planSignature 条件签名，复刻度开关往返零损耗）
- **表情 / 手势 / 视线锁定（ADR-021）**：Rust 分析 schema 新增 facial_expression / gesture / gaze 三字段全链路（DTO / 系统提示词 / 归一化 / TS / 姿态快照分列冻结 / 持久化恢复）；wink 家族按「闭合的那只眼」判左右；编译器新增 expression_lock 装配层（强语义合同，优先级高于风格氛围）；局部插图 mirrors 确定性继承同一表情基线
- **服装来源守卫（ADR-023）**：clothingPolicy=use_subject_reference 时三通道反回灌--模板保留合同行内净化、媒介结构合同层剥离、最终画面描述逐句剥离；装配后 clothingConflicts 兜底校验（非空 = 生成门禁阻断）；same_as_primary 媒介层显式「服装基底来自人物参考图，只做媒介转换」；负面追加词含模板服装令牌
- **Canonical Anime Character（ADR-024）**：三层概念铁律（Person Identity ≠ Anime Character Design ≠ Detail Insert Crop）；AnimeCharacterSnapshot 一修订一角色卡（发型 / 脸型 / 眼型 / 服装冻结，revision 过期即重派生，纯函数零模型调用）；Prompt Compiler 新增【动漫角色一致性合同】+【细节插图同步合同】两级装配；两级守卫（许可句剥离 animeGuard + 整 Prompt 复检 animeConflicts 非空阻断）进 blockingErrors；provenance 冻结角色卡 + 插图绑定（History 角色卡摘要，旧任务兼容文案）
- **Strict Visual Reference / Detail Instance（Visual Consistency V5）**：动漫脸部 / 眼睛 / 发型画框逐实例绑定 + 生成门禁，缺失实例只允许用户触发受限补充识别；角色参考图接入统一报价 / 预留 / 失败释放（缓存命中零新增费用）；人物 / 服装 / 风格及已解析外貌事实进入稳定指纹（动作 / 镜头 / 背景 / 构图不触发重建）；提交顺序固定为模板、人物、动漫角色参考、其它引用
- **Prompt Truth Source / 确认弹层渐进披露**：手动完整 Prompt 贯穿确认预览 / 提交 / 历史；生成链路单次编译断言入测（mergeFinalGenerationPrompt 恰一次，compiled.prompt 直进 carry）；确认弹层默认仅显示决策摘要，高级模型 / 任务 ID / 路径 / 完整 Prompt 默认折叠；系统修正 Toast 与紧凑角色参考卡可进入 Skill Trace
- **方案卡来源显示与规则中心**：@token 渲染为交互 chip（hover 缩略图预览 / 点击打开内置 ImageViewer / 完整名 + 角色说明浮层）；buildPlanSourceRef 唯一构建入口（显式名 > basename > 角色兜底名）；锁定维度 / 人物替换 / 服装行携带真实图片 refs 徽标（「已替换」/「使用 @人物参考 的服装」等）；规则中心（ruleRegistry 常驻 + 按状态启用共 10 项规则可视，含 expression_lock / detail_insert_binding）
- **点数不足充值入口与 Billing CTA 层级**：QuoteConfirmDialog 余额不足时「去充值」Primary CTA -> 账户充值区锚点 + 高亮，充值完成可返回继续生成（一次性 returnContext）；充值 CTA 移入 footer 操作区（不足时全弹层唯一 primary），明细补「还差 N 点」行
- **评价系统增强**：角色一致性评价只读取生成时冻结快照；评价失败不影响生成并提供重试；旧任务不伪造评分

### Fixed

- **已保存项目从列表消失（P0）**：Rust list_visual_projects SQL 把 COALESCE 误写成 COALES，prepare 恒失败导致列表恒空--数据未丢，SQL 提取 LIST_SQL 常量修正 + 新增「执行生产常量本身」的 Rust 回归测试；列表 Popover 显式失败态 + 重试
- **项目删除「复活」（P0）**：store 会话级 deletedProjectIds 墓碑（防抖 / 在途落库迟到不再复活已删项目）+ flushPersist 等待 in-flight；删除当前项目原子清理（关 Library / 关技能抽屉 / 工作区回空态 + 成败 Toast）；legacy 迁移幂等（workspaceIdentityFingerprint + localStorage marker，杜绝重复复制「未命名视觉项目」）+ adoptProject 收养迁移产物
- **混合媒介动漫角色不一致（P0）**：主动漫角色与相框插图生成出不同发型 / 脸型 / 眼型的三根因修复（same_as_primary 关系语义 / 插图镜像误绑真人主体 / 外貌事实未冻结），见上方 Canonical Anime Character
- **Quote 确认弹层主题**：幽灵 token（--bg-surface 等）全部替换为真实语义 token，源码守卫测试防回归
- **技能引擎确定性**：userDecisions[].decidedAt 派生决策改空串（同一项目状态两次执行产出一致）

### Compatibility

- V4.0.x 旧客户端继续可用：USD 充值入口与余额镜像由服务端兼容窗口保障
- 版本 4.0.9 → 4.2.0（内含未发布的 V4.1 视觉工作流全部改进，随本版一并发布）

### Technical

- 新增 useQuoteStore（报价确认全局弹层状态）/ useTaskBillingStore（任务计费展示侧车，localStorage 持久化）/ QuoteConfirmDialog / AccountLedgerPanel / TaskBillingBadge
- serverApi 新增：billing/quote、billing/wallet、billing/ledger、trial/status、trial/claim、pay/create_order_cny；authorize 携 quote_id 冻结报价
- 新模块群：project/（animeCharacter / animeCharacterAssetService / clothingGuard / detailInsert / dimensionLock / lockedDimensionGuard / referenceAppearanceService / ruleRegistry / subjectExpression）、skills/（Runtime Skill 引擎 + exportTrace）、useRuntimeSkillStore、VisualProjectLibrary
- cyimagepro-ui Skill 13.0.0 → 16.0.0：规则 22（Generation Quote & Pricing Transparency）/ 23（Canonical Reference）+ patterns §21-§31（Credits Billing / Trial / Quote / Wallet-Ledger / Project List State Transition / Billing Dialog CTA / Canonical Reference / Detail Group-Instance / Prompt Confirmation Progressive Disclosure / System Correction Toast / Compact Reference Asset Card）
- Rust：VisionSubject 新增 facial_expression / gesture / gaze；visual_projects SQL 常量回归测试；rebuild_visual_project_index 命令
- 测试：Vitest 1165 → 1406（视觉项目 / 技能引擎 / 维度锁定 / 表情锁定 / 服装守卫 / 动漫角色 / V5 实例绑定 / 计费 CTA 等）；cargo 213 → 214（生产 SQL 常量回归）


## v4.0.9（2026-08-24）

### Added

- **视觉复刻修改工作流重构**：视觉理解页「修改要求」升级为结构化维度体系——快捷维度（修改人物 / 服装 / 动作 / 背景 / 镜头 / 风格）每个维度唯一槽位（ModificationChip），再次点击同一维度即取消该意图；自由文本与快捷维度合并为一条合成指令交给 Prompt 优化器，两者共存不冲突；「修改人物」直接打开人物替换面板
- **人物替换（Person Replacement）**：人物参考支持图库素材 / 本地文件 / 文字描述三种来源；服装处理策略严格单选（保留原图服装 / 使用人物参考图服装 / 自定义描述）；服装 / 造型成为复刻方案独立维度（第九维），不再挤占「人物」或「风格」的语义空间
- **最终生图 Prompt 单一事实源（Prompt Provenance）**：Prompt 来源链路唯一化（promptDraft + lockSource 三来源），AI 优化、手动编辑、锁定维度各自可追溯；是否需要重新优化由语义修订号派生（semanticRevision ≠ optimizedRevision），视图层任何变化绝不误触发重新优化
- **Prompt 增删 Diff（修改对比）**：CJK 逐字 / 拉丁字母数字连串 / 标点单字的稳定 token 流 + LCS 对比，输出「不变 / 删除 / 新增」三类连续片段（删除恒在新增之前，token 超限整体替换兜底）；中文与英文 Prompt 都能逐词对比，不再整段误判成「删除 + 新增」
- **UI 状态与生成语义彻底隔离**：新增视觉页 View State store（折叠 / Tab / 展示态唯一载体，纯视图、进程内不持久化，绝不影响生成语义）；语义状态唯一载体仍是 Vision Workspace；分析阶段产品化反馈（参考图缩略图 + 轻量扫描线 + 创意文案确定性轮播，prefers-reduced-motion 自动降级为静态）
- **统一图片评价系统（ImageEvaluation V1）**：评价绑定图片资产而非任务——一个任务产出多张图，每张独立评分；六维度 AI 评分（指令完成度 / 人物一致性 / 参考保持 / 风格一致性 / 构图质量 / 技术质量，0~100 整数，null = 未评价或不适用，绝不拿 0 冒充未评价）；Similarity ≠ Completion——用户要求修改的维度进入 change 语义，评价器不因该维度与原图不同而扣「参考保持」分；preserve / change 直接复用复刻方案锁定结构，不建第二套约束体系；AI 评分与用户反馈（点赞点踩 / 问题标签 / 评论）严格分离；生成后自动评价默认开启（复用 BYOK 视觉模型，与聊天 / 提示词优化同链路，不产生服务端计费；评价失败绝不影响生成任务）；图库按评分桶 / 用户反馈筛选，任务层聚合 best / average，用户反馈一键组装为下一轮优化指令
- **全局内置图片查看器（ImageViewer）**：全局单例，统一入口打开；缩放 10%~800%（工具栏 / 键盘 / 滚轮鼠标锚点缩放）、适应窗口 / 100% 原始尺寸 / 双击复位；放大后拖拽平移；多图切换（← → 方向键）；复制图片（真实二进制进剪贴板）与另存为（Ctrl+S 保存对话框）；Esc / 遮罩空白区域关闭（工具栏 / 详情面板 / 图片本体不误关）；右侧可选信息面板（Prompt 复制 + 业务 metadata）；缩放 / 平移数学唯一来源为纯函数模块（全量单测）
- **图片库拖拽批量导入**：从 Windows 文件管理器直接拖图到图片库页即批量导入（PNG / JPG / JPEG / WebP）；只在图片库页面生效（路由级作用域，其它页面拖图绝不误触发导入）；详情 Modal / 查看器打开时自动挂起并复位拖拽态；导入复用唯一入库链路（import_images_to_library），处理中防重入，导入结果统一文案提示
- **图片来源收口与详情 Metadata**：图库「这张图从哪来」由唯一 resolver 真实判定——任务关联优先（动作白膜 > 视觉复刻 > 批量 > 任务类型），其次 source_kind 细分，「本地」只允许出现在用户主动导入的场景，禁止来源缺失一律回退「本地」；统一来源词：本地 / 文生图 / 图生图 / 编辑 / 批量生成 / 视觉复刻 / CY Video Studio；Gallery Card / 筛选 / 详情 / 查看器四处来源文案同源输出永不分叉；图片详情升级完整 Metadata（来源 / 用途 / 导入时间 / 生成时间 / 尺寸 / 格式 / 文件大小 / 生成模型 / 任务 ID，动作白膜图额外显示批次与槽位）；「来源」（从哪来）与「用途」（在业务里是什么）两个概念彻底分离
- **CY Video Studio 动作白膜批任务（Pose Batch Contract V1）**：CyImagePro 作为接收端通过本地 Task Bridge 提供四个端点——整批创建 / 整批状态查询 / 失败槽位单独重试 / 取消未完成槽位；一批动作白膜 = 一个任务的 N 个子任务（≤8 槽位，视角 × 关键帧白名单校验）；最终图片 Prompt 由本端 ACTION_MANNEQUIN_V1 Preset 统一生成（Preset 后续升级 Video 侧零改动）；requestId 幂等（重复请求返回既有任务，绝不重复生成计费）；失败槽位单独重试，已完成槽位绝不再付费生成；白膜图入图库带 CY Video 来源与批次追踪，任务中心 / 历史 / 图库全链路可见
- **模型选择器分组与计费标识**：模型下拉按「常用模型 / 更多模型」分组（唯一策略事实源：retired / missing 完全隐藏，deprecated 进更多并标注；推荐策展放 registry JSON 数据侧，新增推荐模型不改代码；当前选中与默认模型恒置顶常用区）；计费方式统一徽章整词文案（「API 按量计费」「Coding Plan 套餐」单行不换行，禁止拼接缩写变体）
- **cyimagepro-ui Skill 随仓库分发**：UI 设计系统 Skill（tokens / components / layouts / patterns / copy / model-selector / visual-workflow / image-viewer）持续升级至 Skill 6.0.0 并纳入版本管理（skills 目录 + 开发规范入口），Creator / Vision / Gallery 统一 UI 规则可持续执行

### Fixed

- **图片库来源误判（根因修复）**：当「图片库本地目录」与「默认输出目录」配置成同一目录时（用户实机出现过），目录扫描曾把用户拖入的图片误标为输出而显示「生成结果」——目录平局规则改为本地目录胜，chat / transparent 子目录判定前置不受嵌套影响；读取时任务关联优先级高于 source_kind，历史上被误覆写的旧资产在展示层即可恢复真实来源；外部路径（如微信 / QQ 临时目录）关键词不参与资产来源判定
- **任务图片绑定「复活」Bug**：空绑定语义拆分为四态（未初始化 / 系统自动 / 用户手动 / 用户明确解绑），用户解绑任务图片后切换页面或重启应用不再被自动补回
- **Composer 草稿跨会话串图**：对话输入草稿与图片附件按会话隔离（对话 A 的任务图不再跑到对话 B），切换会话保存 / 恢复各自草稿，页面卸载不丢失；匿名新对话的草稿在建立会话时自动迁移

### Technical

- 评价持久化：app.db 新增 image_evaluations 表（asset_id 主键；重新评价覆盖 AI 字段、保留用户反馈字段；evaluation_version 标记评分口径，Prompt / 权重 / 模型变化后递增，旧分新分不混读）；ImageRecord 新增 file_size 字段（serde default，全产出链路写入）
- Task Bridge 接收端：127.0.0.1 随机端口 HTTP 服务 + task-bridge.json 原子发现文件（host / port / pid / token，正常退出清理），Bearer token 校验，仅接受 CY Video Studio 来源白名单
- 测试：Vitest 452 → 808（新增 356：评价系统 / 修改意图 / Prompt Diff / 来源收口 / 拖拽导入 / 查看器变换 / Pose Batch / 模型分组 / 会话草稿隔离等）；cargo 146 → 185（新增 39：评价聚合与权重 / pose_batch 契约校验 / 同目录 classify 回归 / 桥发现文件等）
- 已知边界：Pose Batch 与 CY Video Studio 的真实付费生成联调尚未进行（Pose Batch real paid generation integration remains to be verified）

## v4.0.8（2026-08-22）

### Added

- **图片生成参考图拖拽（Drop Zone）**：图生图（单张 / 批量）参考图区域新增拖拽框，可直接从 Windows 文件资源管理器拖入 PNG / JPG / JPEG / WebP；拖入悬停时边框高亮、文案变化；本地选择 / 图片库选择 / 拖拽三个入口共用同一导入链（`imageDropFiles.ts` canonical path 去重，反斜杠与正斜杠、大小写差异判定为同一文件）；拖入即解码校验（读缩略图），损坏文件剔除并提示，不影响其余合法图片；混拖中非法文件（txt / exe / 目录）给轻提示；文生图模式下拖入提示先切换图生图。拖入只加入参考图列表，绝不自动提交生成
- **AI 智能体对话图片拖入**：把图片直接拖到对话输入区即可添加附件（输入框覆盖「松开以添加图片」轻提示）；附件结构与「添加照片」按钮 / 图库 / 粘贴完全一致（`buildDroppedChatAttachmentDraft`，同一 `ChatAttachment` 体系，无第三套拖拽附件）；拖入不自动发送、不触发任何模型调用；chat 模式下无可用视觉模型时附件落位即提示「当前模型不支持图片理解，请切换到支持视觉输入的模型」（`chatImageReadiness.ts`，不等发送后报服务端错误）
- **视觉理解生成方式（文生图 / 图生图）**：视觉理解完成后「确认生成图片」前可选生成方式：图生图自动携带视觉理解原图作为参考图（复用既有素材路径，不复制不重复导入），更适合人物 / 服装 / 主体一致性；文生图仅按最终 Prompt 重新创作。默认策略：有原图 → 图生图（不写死关键词判断），用户始终可手动切换；生成方式存入 Vision Workspace（切页面 / 重启恢复）；携带草稿（VisionCarryDraft）新增 `generationMode / sourceImagePath / sourceAssetId`，图生图模式跳转图片工作室后直接看到参考图 + Prompt + 参数完整状态
- **图片模型能力（capability）单一来源**：新增 `features/imageModel/imageModelCapability.ts` —— 图片执行模型目录（V4 = gpt-image-2，双能力）与 capability 门禁唯一入口；文生图要求 `image_generation`、图生图要求 `image_edit`；模型不支持当前生成方式时提交前客户端阻断（「当前图片模型不支持图生图，请切换支持图片编辑的模型。」），不等上游报错；判定依据显式 capability 目录，不按 endpoint 名或模型名猜测

### Fixed

- **视觉理解复刻链路不再强制文生图（V4.0.8 核心修复）**：此前「确认生成图片」硬编码切到文生图并丢弃原图（ImageStudio 消费视觉草稿时强制 `t2i`），导致人物复刻变成纯文生图任务、走 `/v1/images/generations` 通道且不携带参考图；现在默认图生图并携带原图走 `/v1/images/edits` multipart 通道（参考图真实进入图片生成请求，不是把路径写进 Prompt）
- **子任务错误分层文案**：上游图片接口错误消息带 `[endpoint: …]` 标签（与网络错误一致），前端按通道区分——`text_conversation_not_supported` 时区分「服务商图生图接口 / 文生图接口被网关误路由到文本会话通道」（该错误码 V4.0.5 已取证为 packyapi 网关误路由，客户端无法阻止网关行为，但用户现在能看出是哪一层失败）；普通 4xx 区分「当前服务商的图生图接口调用失败 / 文生图接口调用失败」
- **编辑重发保留负面提示词**：EditTaskModal 此前把原任务负面词静默清空，现在完整保留（连同 task_type / 参考图 / 尺寸 / 质量 / 格式一并恢复）

### Technical

- **图片执行路由适配边界（Rust）**：`task_runner.rs` 新增 `ImageExecutionRoute`（Generations / Edits / RemoveBackground / FrontendDriven）+ `resolve_execution_route(task_type)` + `endpoint_url()` —— endpoint 决策唯一入口，图片任务结构上不可能路由到 chat / responses 文本会话通道；`is_frontend_driven_task` 改由路由派生；create/retry 的 task_type 最终决策抽出 `resolve_final_task_type`（重试绝不改变图生图语义，唯一例外保留「参考绑定详情图 generate → edit 升级」启发式）
- **模型职责隔离守卫测试**：源码级断言 ImageStudio 不引用 BYOK 模型解析（chat / planner / prompt_optimizer / vision 模型绝不成为图片执行模型）、Rust 执行层无文本会话 endpoint、图片任务参数不含任何 model 字段、Agent image_edit intent 映射 edit task_type
- **拖拽统一封装**：`hooks/useImageDrop.ts`（Tauri `onDragDropEvent` 窗口级监听唯一封装，dragActive 状态 + 路径分流）+ `utils/imageDropFiles.ts`（扩展名校验 / canonical 去重 / 合并）；视觉理解页既有拖拽处理迁移到同一工具
- 测试：Vitest 410 → 452（新增 42：imageDropFiles 11 / carryApply 7 / imageModelCapability 8 / imageTaskIsolation 5 / chatDropAttachments 3 / chatImageReadiness 3 / workspace generationMode 3，另扩展 subtaskError 分层文案 2）；cargo 146 全过（新增 8：ImageExecutionRoute 路由与 endpoint 5 + resolve_final_task_type 3）

## v4.0.7（2026-08-21）

### Fixed

- 删除历史记录详情底部的「对话历史图片」区块：该列表展示的是与所选任务无关的对话图片，对任务详情没有价值且干扰信息结构（渲染 / 数据查询 / state / CSS 一并移除，非 CSS 隐藏）
- 修复视觉理解页模型下拉出现不可用模型的问题：下拉列表现在只显示「未删除 + 已启用 + Provider 已启用 + 测试通过 + 支持图片视觉」的模型；已删除 / 已禁用 / 测试失败（含 429 限流暂时异常）/ 待测试 / 无视觉能力 / 纯文本模型一律不出现（统一准入 selector `modelUsability.ts`，模型中心是唯一事实源，禁止按名称猜能力）
- 修复模型能力不可见的问题：视觉模型选择器每个选项以纯文本后缀标注能力（如「（图片·视频·思考）」），选中模型旁渲染能力徽章（`ModelCapabilityBadges`，带「支持图片理解 / 支持视频理解 / 支持思考模式」提示）；GLM-5V-Turbo / GLM-4.6V 按 capability 数据标记视频输入（`video_vision`），GLM-4V-Flash 等仅图片模型不虚标
- 修复视觉理解页切换页面后工作区全部丢失的问题：新增 Vision Workspace 持久化（`useVisionWorkspaceStore` + localStorage `vision_workspace_v1`），参考图标识 / 模型 / 模式 / 分析结果 / 复刻方案 / 三个 Prompt / 调整要求 / 生成参数 / 任务关联在页面切换、组件卸载、应用重启后完整恢复；恢复只读取持久化数据与本地缩略图，绝不自动重新调用视觉 API（瞬时进行中状态落盘前归一化，分析中被打断恢复为可重新执行的初始态）；文本输入防抖 500ms 落盘，卸载时冲刷

### Added

- **模型测试状态失效机制**：API Key / Base URL / Provider 类型 / custom 模型 Model ID 任一变更后，旧的「测试通过」状态复位为「待测试」，重新测试成功前不再进入业务页面（429 等暂时异常保留模型配置，重测通过即恢复）
- **重新优化**：已有分析结果时可基于当前图片 + 分析结果 + 调整要求强制再执行一次 AI 优化（按钮提示会再次消耗 Token）；失败时旧结果原样保留，成功后才替换
- **重新开始**：确认弹窗后清空当前工作区（图片 / 分析 / 修改要求 / 最终 Prompt / 推荐参数与持久化数据），回到初始上传状态；历史任务、会话记录、已生成图片与素材库不受影响
- 无可用视觉模型时页面显示明确指引（「当前没有可用的视觉模型，请先到模型管理中启用并测试一个支持图片理解的模型」）并提供「前往模型管理」入口，「提取复刻方案」按钮禁用；已保存的模型选择失效时自动回落到可用列表第一个，无可用则置空（绝不恢复失效模型 ID、绝不硬编码兜底）

### Technical

- capability 体系新增 `video_vision`（视频输入理解，与 `vision` 图片输入独立声明，仅官方文档确认支持的模型标记）；`resolveByokVisionConfig` 新增 `model_not_tested` 错误原因（测试状态准入）；视觉页状态全部迁入 Zustand store（分析异步任务在页面卸载后仍可完成并落盘）
- 测试：Vitest 373 → 410（新增 37：modelUsability 21 / useVisionWorkspaceStore 9 / 重新优化状态机 3 / 文案守卫 4；另更新 2 个旧守卫测试以匹配删除与新命名）；model-registry smoke 补充「未测试不放行 / Key 与 Base URL 变更失效」断言，26 个 smoke 全过

## v4.0.6（2026-08-21）

### Fixed

- 修复批量任务「编辑重发」错误打开单任务表单的问题：批量任务的 6 条 Prompt 是 6 个独立子任务，不再被表示成「1 个 Prompt × 数量 6」；批量任务操作区改为「重做 / 重试失败项 / 删除」（单任务保留原「编辑重发」）

### Added

- **批量任务重做（Batch Redo）**：新 `BatchRedoModal` 支持按子方案勾选（全选 / 清空 / 仅失败项 / 仅成功项）、统一修改尺寸 / 质量 / 格式 / 输出目录 / Prompt 前后缀、以及单方案级标题 / Prompt / 负面词编辑；重做创建全新批量任务（Rust `create_batch_redo_task`，源任务结果与重试历史完全不可变），计费按选中数正常授权结算——retry（原地重置失败槽位）与 redo（新任务）语义彻底分离
- **视觉模型独立类别**：模型服务新增 `vision` 类别（档案级 `category` 字段，旧数据默认 agent，完全向后兼容）；设置页新增「视觉模型」分区（AI 智能体之后），与 Agent 服务卡片共用同一套管理组件；新增真实 Provider：OpenAI 官方、Google Gemini 官方（OpenAI 兼容端点）、阿里云百炼 / Qwen（compatible-mode）、智谱 Vision、第三方 OpenAI Compatible；独立「默认视觉模型」（`defaultVisionProfileId`，与 Agent 默认互不干扰）；能力守卫 `allowsVisionUse`（capabilities 明确声明不含 vision 的纯文本模型一律拦截，unknown 放行），禁止按模型名猜能力
- **视图理解页（侧边栏「视图理解」）**：参考图输入（本地选择 / 拖拽 / 图片库 / 图片库右键「视图理解 / 提取 Prompt」）；三档模式——快速理解、专业反向 Prompt、高复刻；结构化分析结果（主体 / 场景 / 构图 / 镜头 / 光线 / 色彩 / 风格 / 文字 / 风险）可折叠展示
- **确定性 Reverse Prompt 编译器**：Rust `vision_analyze_image` 返回严格 JSON 结构化分析（markdown 围栏剥离 + 包裹键解包 + serde default 容错），TS 侧 `compileReversePrompt` 按固定顺序（主体 → 动作 → 场景 → 构图 → 镜头 → 光线 → 色彩 → 材质 → 风格 → 细节）本地编译，支持 generic / gpt_image 两种 Prompt 方言；输出推荐比例 / 尺寸 / 质量；「带入图片生成」经一次性草稿填入文生图单张表单（绝不自动提交）
- **高复刻验证闭环**：双图交叉评审（Rust `vision_compare_images`，分维度 0~1 相似度 + 缺失 / 多余 / 布局 / 风格 / 光线 / 色彩差异 + 可执行修正指令；评分 clamp 且 >1.5 按百分制换算）+ 本地色彩相似度（Rust `compute_color_similarity`，HSV 饱和度加权色相直方图 18 bins 交集 + 亮度 / 饱和 / 对比度，无 AI 调用）+ 本地构图相似度（两次结构化分析的归一化区域匹配，标签优先 + 不匹配惩罚）+ OCR 编辑距离（源图无文字 → 该维度退出加权并重新归一，绝不当 0 分）；默认权重 30/20/15/10/10/10/5；`RecreationOptimizer` 只按真实差异增量追加修正块（不整段重写，防 Prompt drift）；停止条件：目标分（默认 0.90）/ 最大轮数（默认 2，可选 1~3）/ 改善 < 0.015 / 手动停止；候选图生成走正常任务管线与两阶段计费（每轮 authorize 1 张）
- **成本保护**：普通「提取提示词」绝不生成图片；只有确认弹窗展示生成模型 / 视觉模型 / 最大轮数 / 停止条件并点击「开始（可能产生费用）」后才进入生成-比较循环；UI 明示「复刻相似度为系统估算值，不代表像素级一致率」
- VisionSession 历史记录（localStorage，上限 50 条）：保存分析 / Prompt / 每轮迭代评分摘要，不存 base64

### Technical

- Rust 命令数 56 → 60（`create_batch_redo_task` / `vision_analyze_image` / `vision_compare_images` / `compute_color_similarity`）；`send_with_transient_retry` 升级 pub(crate) 供视觉模块复用（全项目仍只有一份 retry 实现）；视觉请求统一 OpenAI 兼容 chat completions（图片本地降采样至最长边 1536 后以 data URL inline 直传，绝不上传图床；25MB 上限本地拦截）；API Key / base64 不入日志
- 测试：Vitest 229 → 276（新增 redo store 6 / reversePrompt 8 / similarity 15 / optimizer 12 / session 6）；Cargo 111 → 131（新增 batch_redo 8 / vision JSON 解析·clamp·色彩·HSV 12）
- 未实现（如实声明）：本地 CLIP / OpenCLIP 语义嵌入后端（接口位预留，V4.0.6 默认 backend = Vision Judge + 本地色彩；如需更客观的整体语义分，后续版本以 ONNX 可插拔后端补齐，权重不打包安装包）；OCR 无独立本地引擎（文字由视觉模型 text_elements 结构化输出 + 编辑距离比较）

## v4.0.5（2026-08-20）

### Fixed

- 修复「同步到 Video」在未安装 CY Video Studio 时弹出文件/路径选择器的问题：未检测到安装位置时显示安装提示弹窗，手动指定安装位置仅作为弹窗内的高级入口
- 修复图片生成请求受瞬时网络故障（系统代理连接抖动 / 超时）影响导致子任务一次性永久失败的问题：connect/timeout 类错误自动有限重试（最多补 2 次，500ms/1500ms + 抖动退避），HTTP 4xx 业务错误不自动重试
- 修复任务队列「重新提交」绕过两阶段计费的问题：整批重新提交统一走 authorize → settle 计费链路
- 图片/视频生成专用模型（capabilities 声明 image_generation/image_edit/video_generation 且不含 text）不再被解析为 AI 对话 / 任务规划 / 提示词优化模型，避免 text_conversation_not_supported 类上游 400

### Improved

- 批量任务支持失败子任务单独「重新生成」：只重跑失败槽位，已完成子任务的图片与状态保持原样，参数继承任务创建时的快照
- 任务卡新增「重试全部失败项」：一键重试所有失败子任务，计费只预占本轮重试数量
- 批量任务混合结果（有成功有失败）显示为「部分完成」，不再笼统显示「失败」
- 子任务错误分类展示：主界面显示简洁标题与行动建议，技术详情（错误码 / HTTP 状态 / endpoint / 重试历史）折叠到「查看详情」
- 子任务保留重试历史（attempt_errors，最多 5 条）：重试成功后仍可追溯历次失败原因
- 同步到 Video 携带完整创作元数据（用户原始需求 / 优化稿 / 负面提示词 / 是否优化 / 素材标题），Video 端分列入库

## v4.0.4（2026-08-19）

### Fixed

- 修复国内网络点击「立即更新」后安装包仍从 GitHub 下载导致更新失败的问题：更新元数据与安装包下载统一走官方服务器 www.zjcypc.com（GitHub Releases 作为备用通道），签名体系不变
- 修复更新下载失败时错误提示误显示为「检查更新失败」且透出原始 URL 错误的问题：下载失败独立显示为「更新下载失败」并提供「重试更新」按钮，原始错误仅进入诊断日志
- 更新下载/安装失败时不再影响更新日志展示，版本信息保持可读

### Improved

- 更新检查 endpoint 升级为官方主源 + GitHub 备用双通道：官方源不可达时自动回退 GitHub 元数据
- 版本弹窗在失败状态下不再同时显示「重新检查」与「检查更新」两个相近操作
- 设置页更新通道说明更新为「官方服务器（GitHub Releases 备用）」

## v4.0.3（2026-08-19）

### Fixed

- 修复客户端启动阶段（本地设置尚未恢复完成时）服务器模型、公告与 SSE 请求错误使用开发默认地址 localhost:4001 的问题：所有 CyImagePro 服务端请求统一经过 Server Runtime Gate（配置未恢复 → runtime_not_ready 等待语义，不再发起请求）
- 增加生产环境服务器地址保护：localhost / 127.0.0.1 / ::1 回环地址在生产构建中禁止作为服务器地址发请求，返回明确的 configuration_error
- 修复公告 SSE 在服务器地址恢复前连到错误地址、且切换服务器地址后不重建连接的问题
- 修复图片已生成完成但 AI 智能体任务卡片仍停留在「运行中」的问题：任务事件桥先刷新数据再按 taskId 通知，终态可靠到达卡片
- 修复失败子任务统计数量仍显示 0 的问题：任务计数统一由子任务事实派生（reconciliation 模块）
- 已完成的任务不再允许被取消操作覆盖状态（终态保护）
- 增加客户端重启后的异常任务状态收口：启动时对中断的 running/pending 任务自动对账归位

### Improved

- 服务器模型同步单一来源化：同服务器请求去重、按服务器缓存、失败自动退避重试、离线恢复在线后自动刷新、切换服务器自动隔离旧数据与旧重试
- 服务器模型 stale response 防护：请求期间切换服务器时丢弃过期响应
- 设置页增加 Runtime 状态诊断信息（服务器地址解析、运行阶段、模型同步状态）
- 心跳与公告等待 Runtime Ready 后启动，统一客户端 Server Runtime 初始化时序

## v4.0.2（2026-08-18）

### Fixed

- 修复应用内更新检测失效的问题：更新接口请求失败（latest.json 缺失/网络错误）曾被静默当作「已是最新版本」，现明确区分「已是最新」与「检查失败」并支持重新检查
- 修复更新流程缺失下载/安装状态的问题：现在显示真实下载进度，下载完成后由用户确认重启安装
- 修复 v4.0.1 起安装包未附带 updater 签名产物（latest.json/.sig）导致老版本客户端无法在线升级的问题
- 修复客户端心跳必须手动点击「立即上报」才生效的问题：登录成功、会话恢复、连接建立/恢复时自动立即上报
- 修复登出后心跳调度器未停止的问题；重新登录自动重启调度器并切换账户上下文
- 修复心跳调度器重复启动问题：App 级单例，多次导航不再产生多个定时器
- 修复启动时序问题：等待本地设置（server_url/device_id）加载完成后再启动心跳，避免首次上报被跳过
- 修复 device_id 持久化失败被静默吞掉的问题：失败重试并记录告警
- 心跳失败不再影响连接状态与创作功能，仅记录状态并在下一周期自动重试

### Improved

- 更新状态机重构：idle / checking / update_available / latest / check_failed / downloading / restart_required / installing 八态互斥；自动检查与手动检查共用同一逻辑并防重入
- 版本比较改用数值 SemVer 工具（4.0.9 < 4.0.10），更新判断以 Updater Release 为准，更新日志仅作展示
- 发布链路加固：CI 与 Release 均校验四处版本来源（package.json / tauri.conf.json / Cargo.toml / release.ts）一致，Release 完成后自动验证 latest.json 版本与签名完整性
- 设置页心跳状态展示「最后成功心跳」时间；「立即上报」重新定位为手动诊断入口
- 心跳平台字段按实际系统检测（windows/macos/linux），不再硬编码
- 清理 serverApi 临时诊断日志（含响应体输出，避免敏感信息进入控制台）

## v4.0.1（2026-08-18）

### Fixed

- 修复 DeepSeek Planner 长 JSON 输出被截断时无法正确识别的问题
- 增加 Planner 输出截断分类和自动重试
- 修复 Planner transport 日志错误
- 修复"重新规划"需要点击两次的问题
- 修复修改后的任务内容没有正确传入 Planner
- 修复长对话中图生图源图片发生漂移
- Task 源图片创建后固定，不再受后续图片影响
- 修复旧任务更新导致当前活动图片回退
- 增加当前对话历史图片切换
- 增加任务 Source Image 状态和缩略图提示
- 增加图生图源图片执行前校验

### Improved

- Planner 诊断信息更加完整
- 图生图 Source Image 管理统一
- 任务卡图片引用状态更加清晰
- 提升 AI Agent 长对话连续编辑稳定性
