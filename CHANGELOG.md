# Changelog

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
