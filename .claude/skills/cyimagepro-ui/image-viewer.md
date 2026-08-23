# Image Viewer（CyImagePro 内置图片查看器规范，V4.1）

> 唯一实现：`src/components/ImageViewer.tsx` + `src/store/useImageViewerStore.ts`（App 级单例挂载）。
> 缩放 / 平移数学唯一来源：`src/components/imageViewerTransform.ts`（纯函数，含锚点缩放不变式）。
> 项目内所有「可预览图片」点击后统一进入内置查看器；禁止页面再造 Lightbox / 预览 overlay。

## 0. 强制规则（违反即返工）

1. **页面不重复放置大图**：任何页面不得为「已可点击进 Viewer 的图片」再渲染一张放大的重复展示（如视觉理解页旧 SelectedResult 大图已删除）。Thumbnail / Image Card 点击统一进入 Viewer，页面只保留缩略图 + 选中态。
2. **Backdrop click closes viewer**：遮罩（`.image-viewer-overlay`）onClick = close；顶栏 / 工具栏 / 详情面板 stopPropagation；视口内点图片本体 / 拖拽后不关闭，点图片外暗区冒泡到遮罩关闭。禁止用一个覆盖全屏（inset: 0）的透明 Content 吞掉 Overlay 点击。
3. **Wheel zoom only inside ImageViewport**：滚轮监听只绑定 `.image-viewer-viewport`（非 passive + preventDefault），Header / Toolbar / Detail Panel 等区域滚轮行为正常（详情面板可滚动）。禁止 window / document 级 wheel 缩放。
4. **Viewer keyboard listeners exist only while Viewer is open**：键盘（Esc / ± / 0 / 1 / ←→ / Ctrl+C / Ctrl+S）监听随 `open` 挂载、关闭即 removeEventListener 解绑，绝不影响页面的 Textarea / Input / Prompt Editor。
5. 缩放以**鼠标在视口内的位置为锚点**（applyZoom anchor）；命中 10%~800% 上下限时视图整体不变。

## 1. 哪些图片可点击（接入范围）

| 接入 Viewer | 不接入 Viewer |
|---|---|
| 参考图 / 源图、生成结果图、图库图片、历史任务图片、任务结果图、视觉理解图片、人物 / 素材缩略图、AI 评价图片 | Logo、Icon、Avatar、装饰图、按钮图标、Provider Logo |

已接入（V4.1）：视觉理解页（参考图 + 结果缩略图点击）、图片生成页参考图 Tile、图片库详情 Modal 大图（PreviewModal preview-body img 点击，V4.1 拖拽导入轮渐进迁移）。
渐进迁移中（保留存量实现，改造到哪个页面哪个接入）：图库卡片→详情 Modal（Modal 内大图已进 Viewer）、AI 智能体 Chat（img-preview-modal）、历史记录 History（api.openFile 系统打开）。

## 2. 打开方式（唯一入口）

```ts
useImageViewerStore.getState().openViewer(items, index)
```

```ts
interface ImageViewerItem {
  id?: string;          // 多图切换 key
  src?: string;         // 完整图 URL（data URL）；与 path 二选一，src 优先
  path?: string;        // 本地路径（组件内 readImageData 加载 + 缓存）
  title?: string;       // 顶栏标题
  width?; height?;      // 已知尺寸（顶栏展示）
  fileName?: string;    // 另存为默认文件名
  prompt?: string;      // 生成 Prompt（详情面板可复制）
  metadata?: { label: string; value: string }[];  // 业务元信息（评分 / 反馈 / 来源）
}
```

可预览图片的 cursor 一律 `zoom-in`；Viewer 内可平移时 `grab` / `grabbing`（仅 scale > fit 时平移，未放大不产生偏移）。

## 3. 结构与事件作用域

```text
ImageViewerOverlay（fixed inset:0，backdrop，onClick=close）
├─ ImageViewport（有界区域：top 52 / bottom 76 / left·right 20；has-detail 时右移）
│   └─ ImageTransformLayer（translate(-50%,-50%) translate(offset) scale）
├─ Topbar / Toolbar / DetailPanel（stopPropagation，不触发关闭）
```

- 关闭三通道：点击灰色背景（backdrop / 视口内图片外暗区）、Esc、右上角 ×。
- 拖拽平移后松开的 click 不触发关闭（DRAG_CLICK_TOLERANCE 抑制）。

## 4. Viewer 行为与工具栏

- 缩放：10% ~ 800%；工具栏 `− / 百分比 / ＋ / 适应窗口 / 100%`；滚轮（视口内，鼠标锚点）；双击 = 适应窗口。
- 平移：放大后（scale > fit）拖拽平移（grab / grabbing）。
- 多图切换：`← / →`、工具栏箭头、顶栏 `2 / 4` 位置指示；循环切换。
- 复制图片：**真实图片二进制**写入系统剪贴板（`utils/imageClipboard.ts`，ClipboardItem + canvas 回落）；绝不只复制路径 / URL。
- 另存为：Tauri 保存对话框（`api.saveImageAs`，禁止 WebView 浏览器保存）。
- 信息：顶栏轻量显示标题 + 尺寸 + 位置；「详情」右侧面板展示 Prompt（可复制）+ 业务 metadata；无 metadata 只显示图片。
- 加载失败显示「图片读取失败」占位，不弹错误弹窗。

## 5. Keyboard Shortcut（全量，仅 Viewer 打开期间）

| 键 | 行为 |
|---|---|
| Esc | 关闭 |
| + / = | 放大 |
| - / _ | 缩小 |
| 0 | 适应窗口 |
| 1 | 100% |
| ← / → | 上一张 / 下一张（多图时） |
| Ctrl/Cmd + C | 复制当前图片（有文本选区时让位系统复制） |
| Ctrl/Cmd + S | 另存为（preventDefault，禁止 WebView 保存页面） |

## 6. 规则

1. 每个页面不得复制一套 Viewer；一律组装 ImageViewerItem[] 交给全局单例。
2. 生成结果类图片必须携带 `prompt`（该张图实际提交的 Prompt 快照，如 task.final_prompt / batch_items.prompt_override），保证「这张图当时用了什么 Prompt」随时可查。
3. Viewer 不承载业务操作（删除 / 重试 / 同步 Video 留在各自页面的详情视图）。
