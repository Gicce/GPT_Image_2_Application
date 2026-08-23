# Golden Samples + Compliance Check（CyImagePro）

## 1. Golden Samples（开发前先看这些实现）

| 场景 | 文件 / 组件 | 说明 | 禁止误用 |
|---|---|---|---|
| 标准导航项 | `src/components/Sidebar.tsx` | 恒深侧栏 220px、active 淡靛蓝、图标 + 13px label | 不要在业务页再画侧栏 |
| 标准会话项 | `Chat.tsx` ConversationListItem | 44px 行、active 高亮、双击重命名、hover 删除 | — |
| 标准任务卡 | `src/components/TaskMessageCard.tsx` | 状态机展示、操作按钮组、结果图卡 | 不要另起任务卡实现 |
| 标准图片卡 | Chat.tsx generated-img-container / Gallery 卡 | hover overlay「点击查看大图」、缩略图 + meta | — |
| 标准按钮 | `src/App.css` `.app-btn-*` 系 | radius 8 / 10px16px / 13px600 | 不要页面内手写按钮样式 |
| 标准输入 | `src/App.css` `.form-group` | Label→控件→helper，focus 主色描边 | — |
| 标准模型选择器 | `src/components/ModelPicker.tsx` + `ModelPicker.css` | 搜索/分组/更多模型/整词 Badge | 禁止任何页面再写模型下拉 |
| 标准 Badge | `src/components/BillingBadge.tsx` | flex-shrink 0 + nowrap 整词 | 计费文案不得手写 |
| 标准确认弹窗 | `src/components/DeleteConvDialog.tsx` | overlay + 卡片 + busy 态 + 取消/删除 | — |
| 标准 Toast | `src/components/Toast.tsx` | toastSuccess / toastError | 不要 alert() |
| 标准空状态 | `src/pages/Chat.tsx` chat-welcome / `.empty-state` | 主文案 + 引导 | — |
| 标准媒体输入（MediaInput） | `src/pages/ImageStudio.tsx` ReferenceImageInput | Empty/Loaded 互斥状态机：紧凑可点击 Dropzone（120~140px）→ 96px Tile 网格 + Add Tile；移除 = neutral 遮罩 Hover 才 danger；文件名只进 Tooltip（扩展名徽标代替）；DragOver 双态反馈。规则见 patterns.md §11 | 禁止「Dropzone + 外部缩略图」两区域并存；禁止常驻红色删除钮 |
| 标准错误横幅 | Chat.css `.chat-model-error` | 文案 + 重试 + 关闭，neutral 变体 | — |
| **Creator Workspace Golden Sample** | `src/pages/ImageStudio.tsx` + `ImageStudio.css` | 图片生成页整套工作台：MainCreator + TaskSidebar 网格（320px 侧栏不压缩）、Segmented 模式条（`.studio-seg`）、Section 标题（`.studio-section-head.divided`）、`GenerationSettings` 面板（三模式共用）、`studio-cta-btn` Primary CTA（sticky 侧栏内、Disabled 降透明度）、StatCard（2×2、按状态提亮）、最近任务（状态点+状态词+进度）、AI 辅助胶囊（`.studio-ai-chip` 模型名 ellipsis） | 视觉理解 / 图片编辑 / 未来 Creator 页面优先复用此布局；契约守卫 `src/pages/__tests__/imageStudioUi.test.ts`（12 例） |

## 2. CyImagePro UI Compliance Check（每次 UI 修改后执行）

### Token

- [ ] 无新增随机 `#hex` / `rgb()`（存量 rgba 徽章底除外）
- [ ] 无无理由 magic spacing（17px/13px/11px 这类）
- [ ] 未重新发明 font-size / radius / 控件高度
- [ ] 新颜色同时落在 light/dark 两个主题变量

### Components

- [ ] 未重复实现已有 Button / Badge / Dialog / Toast / ModelPicker
- [ ] 业务组件没有直接写裸 `<button>/<input>/<select>` 新样式
- [ ] 计费 / 模型列表没有绕开 BillingBadge / modelUiPolicy

### Layout

- [ ] 侧栏 220px / 会话栏 240px 未被重定义
- [ ] 聊天流新元素套用 `--chat-content-max-width`
- [ ] Popup/Modal 符合弹窗模板（max-height + 内滚 + footer 按钮）
- [ ] 滚动归属正确（该谁滚谁滚，页面不双滚）

### Copy

- [ ] 术语 / 状态词 / 计费词来自 copy.md，无同义词漂移
- [ ] 按钮动词统一（确认执行/取消/删除/重试…）
- [ ] 标点 / 中英混排符合规范

### Responsive（1280 / 1440 / 1920 / 2560）

- [ ] 无重叠、无越界、无横向滚动
- [ ] Badge 单行（特别检查「API 按量计费」不拆词）
- [ ] 长模型名 / 长文件名 ellipsis 而非换行撑爆
- [ ] Dropdown 不覆盖整个工作区

### 回归

- [ ] `npm run typecheck && npm test && npm run build` 全绿
- [ ] 涉及模型选择器 / 计费 → modelUiPolicy / billingBadge 测试通过
