# Components（CyImagePro 公共组件规范）

> 原则：相同 UI 出现 2 次以上必须公共化。新代码禁止页面内手写裸 `<button>/<input>/<select>` 自定义样式；
> 项目没有独立 Button/Input React 组件，按钮走 App.css 共享类，其余优先复用下列组件。

## 1. 共享按钮类（App.css，等价于 Primitive Button）

| 类 | 语义 |
|---|---|
| `.app-btn-primary` | 主操作（每区域最多 1 个） |
| `.app-btn-secondary` | 次操作 |
| `.app-btn-danger` | 危险操作（确认充值/提交退款守卫测试锁定其配色） |
| `.app-btn-sm` | 小尺寸修饰 |
| `.settings-btn-link` / `.settings-btn-sm` | 行内链接按钮 / 小按钮 |
| `.chat-input-btn` | Composer 32×32 图标按钮 |
| `.chat-btn-send` | 发送（主色实底，任务态加 `.task-mode`） |

图标按钮 32×32 必须 `title` 提示。

## 2. 公共组件清单（src/components/）

| 组件 | 用途 | 复用规则 |
|---|---|---|
| `Toast.tsx`（toastSuccess/toastError） | 全局轻提示 | 操作反馈一律用它，禁止 alert()（存量 alert 为债务） |
| `BillingBadge.tsx` | 计费方式唯一展示形态（API 按量计费 / Coding Plan 套餐） | 禁止任何地方手写计费文案 span |
| `ModelPicker.tsx` | AI 智能体模型选择器（搜索/分组/更多模型） | 模型选择场景唯一入口，见 model-selector.md |
| `ModelCapabilityBadges.tsx` | 模型能力标签组 | 模型能力展示复用 |
| `ProviderLogo.tsx` | Provider 品牌 Logo（本地资产 + 首字母回退） | 禁止外链 logo |
| `ContextMeter.tsx` | 上下文余量指示条 | Chat 头部 |
| `TaskMessageCard.tsx` | 聊天内任务卡（状态机展示） | 任务卡 UI 唯一实现 |
| `BatchPlanCard.tsx` / `BatchPlanDetailDrawer.tsx` | 批量方案卡/详情抽屉 | |
| `DeleteConvDialog.tsx` / `DeleteTaskDialog.tsx` / `EditTaskModal.tsx` / `SuccessDialog.tsx` / `VersionModal.tsx` | 确认/编辑弹窗家族 | 新增确认弹窗参考其结构（overlay + 卡片 + 取消/主操作 footer） |
| `TaskFilterBar.tsx` | 任务过滤条 | 列表筛选复用 |
| `TokenField.tsx` | Key/Token 输入（显隐控制） | 凭据输入复用 |
| `PromptTextBlock.tsx` | 提示词展示块 | |
| `ImageViewer.tsx`（+ `store/useImageViewerStore`） | 全局内置图片查看器（缩放/平移/多图/复制/另存为/快捷键），App 级单例 | 所有可预览图片唯一查看形态，见 image-viewer.md；禁止页面再造 Lightbox |
| `UpdateNotification.tsx` / `MarqueeNotice.tsx` | 更新通知 / 跑马灯公告 | |
| `GalleryDropOverlay.tsx` | 图片库拖拽导入 Overlay（纯 UI：Brand 虚线框 + 文案渲染） | 导入逻辑禁止写在 Overlay；文案只来自 galleryDropOverlayCopy，见 patterns.md §18 |
| `Sidebar.tsx` | 主导航 | 导航项样式唯一来源 |
| `ErrorBoundary.tsx` | 异常兜底 | |
| `AccountUsagePanel.tsx` / `AccountUsageCharts.tsx` | 账户用量 | |

## 3. 业务组件（页面内已公共化的模式）

| 组件 | 位置 | 说明 |
|---|---|---|
| ConversationItem / ConversationList | Chat.tsx | 会话侧栏（虚拟化 46px 行高） |
| ChatComposer（chat-input-box 结构） | Chat.tsx | Composer：topbar 模式切换 → 上下文栏 → 输入框 → 工具条 + 发送 → disclaimer 行 |
| AgentProposalCard | Chat.tsx | 任务提案卡 |
| GallerySearchPanel | Chat.tsx | 图库检索面板 |
| ReferenceImageInput | pages/ImageStudio.tsx | MediaInput 模式的参考图输入（Empty/Loaded 互斥状态机 + Tile/Add Tile + secondary danger 移除），见 patterns.md §11；人物/场景/首尾帧等媒体输入复用此形态；Tile 点击进内置 ImageViewer（V4.1） |
| MessageItem | Chat.tsx | 消息气泡（用户/智能体/思考过程/代码块） |
| WorkflowStatusBanner | pages/VisionUnderstanding.tsx（vision-status-row / vision-status-bar） | 状态点 + 标签 + 引导语五 tone；CTA 在 Banner 外，见 visual-workflow.md |
| VisualAnalysisProgress | features/vision/VisualAnalysisProgress.tsx | 视觉理解「正在分析」阶段反馈（参考图缩略图 + 创意文案轮播 `getVisualAnalysisMessage` + 扫描线/呼吸描边 + reduced-motion 降级）；只在真实 analyzing 阶段渲染，见 visual-workflow.md §1a |
| ModificationChip 行（ModificationChips） | features/vision/ModificationChips.tsx | 快捷修改维度结构化选择器（toggle / 同维度唯一槽位 / aria-pressed / ✓ 前缀 + Brand Soft 选中态 / 提高复刻度独立虚线 Chip）；定义单一来源 modificationIntent.ts，见 visual-workflow.md §1b |
| PersonReplacementPanel | features/vision/PersonReplacementPanel.tsx | 人物替换输入器（图片库人物 / 本地导入 / 文字描述 三来源 tab + ClothingPolicy radiogroup + 自定义服装输入 + 缩略图进 ImageViewer）；语义边界：Tab 切换是视图，人物数据才是语义，见 visual-workflow.md §1c-1d |
| useVisionViewStore | store/useVisionViewStore.ts | 视觉页 View State 唯一载体（dimensionsCollapsed / advancedCollapsed / analysisDetailCollapsed / promptView；进程内不持久化）；禁止塞进业务对象，见 visual-workflow.md §1e |
| modificationIntent.ts | features/vision/modificationIntent.ts | 修改意图纯函数层（ModificationDraft / toggle 唯一槽位 / buildModificationInstruction 合成指令 / ClothingPolicy 指令文本 / 持久化迁移） |
| FinalPromptEditor（vision-final-prompt） | pages/VisionUnderstanding.tsx | 最终生图 Prompt **唯一**查看/编辑/Diff/复制入口（最终版本 Tab 可编辑 promptDraft、修改对比 Tab Diff、四态状态徽章）；禁止第二套「编辑生成方案」输入框 |
| PromptDiff（diff-seg） | pages/VisionUnderstanding.tsx（FinalPromptEditor 修改对比 Tab 内） | 全文 Diff 渲染（新增绿 / 删除红 + 删除线 / 未变化普通色）；计算唯一来源 features/vision/promptDiff.ts |
| DimensionCard（vision-plan-field） | pages/VisionUnderstanding.tsx | 维度锁定卡（锁定/可修改/已修改角标 + ·手动标识 + 原/新对比） |
| ResultThumbnail（vision-result-item） | features/evaluation/VisionResultSection.tsx | 结果缩略图（选中描边 / 评分徽章 / 收藏 ♥ / hover 快捷操作；点击 = 选中 + 进全局 Viewer；页面无重复大图） |
| resolveImageSource | utils/imageSource.ts | 图库来源唯一 resolver（任务继承 > 记录缺失生成 > library_input 本地 > 扫描生成）；禁止 local 兜底，见 patterns.md §17 |
| resolveImageDetailMetadata | features/gallery/imageDetailMetadata.ts | 图库详情 / ImageViewer metadata 唯一 view-model resolver（基础信息行：文件名/来源/用途/导入时间/生成时间/尺寸/格式/文件大小/生成模型/任务 ID + 动作白膜批次区 + viewerMetadata）；内部复用 resolveImageSource，禁止复制其推断逻辑 |
| useGalleryFileDrop | hooks/useGalleryFileDrop.ts | 图片库 OS 文件拖入唯一入口（Tauri onDragDropEvent → controller；api / Toast / store 刷新注入；enabled=false = Modal 打开），见 patterns.md §18 |
| galleryFileDrop controller | features/gallery/galleryFileDrop.ts | 拖拽状态机（enter/over/leave/drop + processing 防重入）+ Overlay / Toast 文案唯一来源（galleryDropOverlayCopy / describeImportResult）；纯逻辑无 React/Tauri 依赖 |
| EvaluationSummary / EvaluationPanel | features/evaluation/ | 评分摘要与详情（跟随选中缩略图；长文本 2~4 行折叠） |
| FavoriteButton（vision-result-quick 内） | features/evaluation/VisionResultSection.tsx | ♡/♥ 收藏 Toggle（与 👍 满意分离，落 image_evaluations.favorite） |

## 4. Badge 体系（禁止重复造）

| Badge | 实现 | 语义 |
|---|---|---|
| BillingBadge | `components/BillingBadge` | 计费方式（muted 描边胶囊） |
| 能力标签 | `model-option-tag vision/ok/warn/new/lifecycle`（ModelPicker.css）+ ModelCapabilityBadges | 视觉=info 蓝、warn=琥珀、new=紫、即将弃用=muted |
| 状态徽章 | `--badge-success/danger/muted-*` | 成功/失败/中性 |
| Token 角标 | `--bg-token-badge` | 消息 token 消耗 |

Badge 布局铁律：`flex-shrink: 0` + `white-space: nowrap`；空间不足时只允许相邻文本（模型名/文件名）ellpsis，Badge 永不换行、永不截断。

## 5. 表单结构

```text
.form-group
  label（13px/500）
  input / select / textarea（14px，radius 8，padding 9px 12px，focus 主色描边）
  helper / error（12px，error 用 --text-error）
```

凭据类输入用 TokenField；长文本 textarea（`resize: vertical; min-height: 60px`）。

## 6. 渐进迁移等价表

| 存量写法 | 新代码等价 |
|---|---|
| 页面内 `.xxx-btn` 手写背景/圆角 | `.app-btn-secondary`（+ `.app-btn-sm`） |
| 手写 `<span class="xxx-tag">计费…</span>` | `<BillingBadge mode={…} />` |
| 手写模型下拉/白名单 | `<ModelPicker>` + modelUiPolicy |
| 手写 overlay 确认框 | Dialog 组件家族模式 |
| alert()/错误只用 Toast | Toast + inline error（关键表单） |

存量页面不动；**改到的组件顺带迁移到等价写法**。
