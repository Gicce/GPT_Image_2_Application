# AI Model Routing（AI 模型路由专项规范，V4.1）

> 实例：`src/features/aiRouting/`（modelRoles / modelRoutingPolicy / resolveModelForRole / roleModelFilter / AiModelUsageSettings）。
> 回答产品级问题：「项目中的每一个 AI 功能到底使用什么模型？」

## 0. 两条最高铁律

```text
No AI feature may silently inherit an unrelated global model.
（任何 AI 功能不得静默继承无关功能的全局默认模型。）

Displayed model MUST equal resolved runtime model.
（用户看到的模型 = 实际执行的模型；除非 UI 明确显示发生了 fallback。）
```

违反即返工。历史上「视觉页显示 GLM-5V-Turbo、Prompt 优化实际跑 deepseek-v4-flash」即违反两条铁律的典型事故（根因：`resolveForUse('prompt_optimizer')` 只在 agent 类别档案解析，vision 档案被排除后回落 agent 默认模型）。

## 1. 架构

```text
AI_MODEL_ROLES（modelRoles.ts，角色目录：一个 AI 功能 → 一个 role）
        ↓
useAiModelRoutingStore（modelRoutingPolicy.ts，用户路由配置 ai_model_routing_v1；
        只存用户改过的条目，缺失 = 推荐 follow，rehydrate 零迁移）
        ↓
resolveModelForRole(role, context)（resolveModelForRole.ts，唯一解析入口）
        → ResolvedAiModel { resolvedModelId / provider / source / followedRole / fallbackReason }
        + AiRoleConnection（token / baseUrl / model，直接用于发起请求）
        ↓
调用方（promptOptimizer / batchPlanner / evaluationService / Chat / Planner）
        发请求前 logAiTransport + recordAiRoleUsage
```

## 2. Role 目录（以真实审计为准，禁止虚构）

| Role | 功能 | 分组 | 能力 | 可配置 |
|---|---|---|---|---|
| vision_analysis | 视觉理解（看图 / 结构化分析 / 高复刻评审） | 视觉与复刻 | vision | external（视觉模型设置页） |
| vision_prompt_optimizer | 复刻 Prompt 优化（含修改意图识别 changed_dimensions / 人物服装语义判定 —— 同一次调用，不单列 role） | 视觉与复刻 | text | routing（默认跟随 vision_analysis） |
| image_evaluation | 图片结果评价 | 视觉与复刻 | vision | routing（默认跟随 vision_analysis） |
| image_generation | 图片生成（gpt-image-2，服务端计费） | 图片创作 | server_image | fixed |
| image_prompt_optimizer | 图片 Prompt 优化（含多对象拆分） | 图片创作 | text | routing（默认 = agent 档案提示词优化链） |
| batch_planner | 批量方案规划 | 图片创作 | text | routing（默认跟随 image_prompt_optimizer） |
| assistant_chat | 智能体普通聊天（会话可单独切换；设置页显示默认值） | AI 智能体 | text | external（AI 智能体设置页） |
| agent_planner | 任务规划（plan_task / interpret） | AI 智能体 | text | external（planner scope） |

## 3. 来源语义（source）

```text
manual   手动指定   —— 用户在「AI 模型使用」显式选择（或既有 per-profile scope 配置）
follow   跟随       —— 跟随另一项功能当前选择的模型（followedRole；UI 显示「跟随「视觉理解」」）
default  系统默认   —— 档案默认模型 / 会话解析兜底
fallback 当前回退   —— 预期模型不可用的显式回退；必须有 fallbackReason 且 UI 可见
```

规则：

1. **follow 目标固定为 role 的 defaultFollow**（设置页只提供推荐跟随；架构上排除 follow 环）。
2. **manual 失效（模型删除 / 停用 / 能力不符）→ 显式回退推荐链**（source='fallback' + `原指定的模型已不可用：…`），绝不断链、绝不空白。
3. **vision_prompt_optimizer 的 follow 失败 → 回退 agent 提示词优化链**（文本任务可跨类别回退）；**image_evaluation 不跨类别回退**（文本模型无法看图，回退必坏 → 如实报错）。
4. **能力判断只看 capabilities**（text / vision / image-only），禁止 `model.name.includes('V')` 式猜测；unknown / 未声明不拦截。
5. 偶发请求失败**不触发换模型**——按既有 retry policy 处理；fallback 只在「模型不可用 / 能力不符」时发生。

## 4. 调用方接入契约

任何 AI 请求发起前：

```ts
const resolution = resolveModelForRole('vision_prompt_optimizer', { visionPreferred });
if (!resolution.ok || !resolution.connection) { /* 结构化错误，禁止自行兜底 */ }
recordAiRoleUsage(resolution.resolved);   // 进程内「最近使用」（设置页轻量展示）
logAiTransport(resolution.resolved, 'vision-recreation');  // console [AITransport] …
await api.runAgentRequest({ mode: 'chat', role: 'vision_prompt_optimizer', feature: '…', …resolution.connection });
```

- Rust `run_agent_request` 的 `[AITransport]` 日志行统一携带 `role / feature / model / billing_mode`；视觉 / 评价命令（vision_analyze_image / vision_compare_images / evaluate_image）在命令入口打印同格式日志。
- 日志**禁止**出现 API Key / Bearer token / Secret。

## 5. @图片上下文（多模态优化器）

- 优化器模型 capabilities 含 `vision` 且存在人物替换参考图 → 参考图经 `read_image_data`（data URL）以 `image_url` part 进入真实 multimodal payload；userContent 显式声明「已随消息附上真实图片」。
- 纯文本优化器只接收**视觉分析产出的结构化描述**（维度 / 人物文字描述），不伪造图片上下文；`optimizerReceivedPersonImage` 如实记录。
- 测试不能只断言文本包含路径 —— 必须断言 parts 里存在 image_url（见 `visionOptimizerRouting.test.ts`）。

## 6. 设置页「AI 模型使用」（设置与更新 → AI 模型使用）

- 布局：Section → 分组（视觉与复刻 / 图片创作 / AI 智能体）→ Role Row。
- 每行至少显示：功能名 + 说明、模型 + Provider（ProviderLogo）、计费（BillingBadge 唯一形态）、配置来源（跟随「X」/ 单独指定 / 系统默认 / 当前回退）、最近使用（进程内数据，无则不显示）。
- 可 routing 配置的 role：「跟随（推荐）/ 单独指定」radiogroup + ModelPicker（`buildRolePickerGroups` 按 role 能力过滤：vision role 只出 vision 能力模型；text role 不出 image-only）+ 「恢复推荐设置」。
- external role 的[更改]跳转对应设置页（视觉模型 / AI 智能体）；fixed（gpt-image-2）只读。
- **设置页 resolve 是只读操作**：UI-only 铁律 —— 打开 / 展开 / 选择 / 关闭绝不触碰视觉工作区 semanticRevision（`routingUiOnly.test.ts` 锁定）。

## 7. 运行时可见性（视觉理解页）

- 「优化复刻 Prompt」按钮旁常驻轻量标签：`Prompt 优化 · GLM-5V-Turbo · 跟随视觉理解`（点击前就能知道，不用去日志猜）。
- optimizing 状态按钮文案带模型；follow 解析失败时按钮区下方显示回退原因（warn hint）；优化成功若发生 fallback，Toast 明示「已从 X 回退至 Y」。
- FinalPromptEditor 头部 Provenance：`由 GLM-5V-Turbo 优化 · HH:MM`（有数据才显示，旧数据缺失不伪造）。
- 「确认生成图片」弹层列出四行模型快照：视觉分析 / Prompt 优化 / 图片生成（gpt-image-2）/ AI 评价。

## 8. Provenance（执行时快照）

- `RecreationState.optimizerModelId / optimizerProviderId / optimizerSource / optimizerFallbackReason`：优化成功即落位并持久化（session / workspace）；之后换设置不影响历史 state。
- `buildGenerationCarry().optimization` 携带 `modelId / source / optimizedAt` 冻结快照进入图片工作室。
- 评价的 `evaluated_by`（Rust 落库）= 评价执行时模型 id。
- 历史结果只显示执行时快照；缺失字段显示为空，禁止回填当前设置。

## 9. 测试守卫（禁止回退）

- `src/features/aiRouting/__tests__/modelRouting.test.ts`：Bug 回归（GLM-5V-Turbo ≠ deepseek）、manual、follow 切换同步、显式 fallback（reason 非空）、设置页映射（无 undefined）、能力过滤、推荐条目。
- `visionOptimizerRouting.test.ts`：请求 payload 的 model/role/feature、@图片 image_url part、纯文本模型不收图。
- `routingUiOnly.test.ts`：路由读写不弄脏视觉工作区语义状态。
- `recreationProvenance.test.ts`：快照保存 / 旧数据兼容 / 历史不变。

改 modelRoles / modelRoutingPolicy / resolveModelForRole / roleModelFilter 必须跑全部相关测试。
