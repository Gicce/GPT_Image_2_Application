# Model Selector（模型选择器专项规范）

> V4.0.9 建立的模型选择 UI 治理。核心思想：**展示策略是数据 + 集中策略函数，不是组件内逻辑**。

## 1. 架构

```text
registry JSON（glm/deepseek/openai/gemini/qwen.json，含 recommended 标记）
        ↓ mergeModelCatalogs（store 持久化，永不删模型）
AIProviderModel（lifecycle / enabled / use_scopes / capabilities / test_status）
        ↓ splitModelsForPicker（src/features/aiProviders/modelUiPolicy.ts）
primary（常用 3~6 个）/ secondary（更多模型）
        ↓
ModelPicker 组件（src/components/ModelPicker.tsx，只消费分组结果）
        + BillingBadge（计费文案唯一形态）
```

## 2. Model UI Policy 规则（modelUiPolicy.ts）

### 完全隐藏（primary/secondary 都不出现）

- `lifecycle = retired`（已下线）或 `missing`（已停止发现）
- `enabled = false`（模型禁用）
- 模型级 `use_scopes.chat = false`（Provider 级在 Chat.tsx 分组入口已过滤，policy 再防御一次）

### 常用区（primary，默认展示）

种子顺序：

1. 当前会话选中模型（永远可见）
2. `profile.default_model_id`
3. registry `recommended: true`（按 registry 顺序；仅 active 生命周期）

种子不足 3 个 → 按「test_status=available 优先 → 目录原顺序」补齐到 3；上限 6。
**deprecated 永不进常用区。**

### 更多模型（secondary）

其余全部 active 模型 + deprecated 模型（行内标注「即将弃用」）。折叠入口「更多模型（N）」逐 Provider 展开；**不删除任何模型入口**。

### 推荐数据（策展在 JSON，不在代码）

新增推荐模型 = 只改 registry JSON（如 glm.json），禁止把 model_id 白名单写进组件/页面。禁止 `name.includes("V"/"Flash"/"免费")` 之类按名称猜能力——能力判断只看 `capabilities` / `supports_vision`。

## 3. Dropdown UI 规则（ModelPicker.tsx / ModelPicker.css）

- 顶部搜索框「搜索模型…」（匹配 model_id + display_name，搜索时全量展开匹配项、隐藏无匹配分组）
- Provider 分组头：ProviderLogo + 名称 + BillingBadge
- 面板 `max-height: 380px` + `overflow-y: auto`（禁止无限增长覆盖工作区）；`width: 300px`
- 模型行：名称单行 ellipsis（唯一可截断元素）+ 标签（✨新 / 视觉=info 蓝 / ⚠=琥珀 / 即将弃用=muted）+ 当前项 ✓
- 所有标签 `flex-shrink: 0` + `nowrap`
- 空目录：配置引导（「尚未配置 AI 对话模型」+ 前往设置）；无匹配：「没有匹配的模型」
- Esc / 点击外部关闭

## 4. 触发按钮（胶囊）

结构：`ProviderLogo → 模型名(ellipsis) → BillingBadge(整词) → Chevron`。
按钮 `max-width: 320px`；`.model-picker-name` 与 `.model-picker-name-text` 都 `min-width: 0`。
空间不足时**只允许模型名截断**；BillingBadge / Chevron 永不收缩、永不换行。

## 5. 测试守卫（禁止回退）

- `src/features/aiProviders/__tests__/modelUiPolicy.test.ts`：推荐来源、隐藏规则、分组、选中置顶、补齐、上限
- `src/components/__tests__/billingBadge.test.ts`：计费整词、Badge nowrap/flex-shrink、面板 max-height、Chat.css 不再重复定义选择器样式

改 ModelPicker / modelUiPolicy / BillingBadge / registry recommended 必须跑全部测试。
