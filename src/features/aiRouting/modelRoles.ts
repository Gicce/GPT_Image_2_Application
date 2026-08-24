/**
 * AI Model Role（V4.1）—— 项目所有真实 AI 能力的模型角色集中定义。
 *
 * 铁律（ai-model-routing.md）：
 *  - No AI feature may silently inherit an unrelated global model.
 *    （任何 AI 功能不得静默继承无关功能的全局默认模型。）
 *  - Every AI model invocation must have an explicit model role.
 *    （任何 AI 模型调用必须携带显式 model role。）
 *
 * 一个 AI 功能 → 一个 model role；角色目录以审计结果为准，禁止虚构。
 * 「复刻修改意图识别 / 人物服装语义判定」与「复刻 Prompt 优化」是同一次
 * AI 调用的结构化输出（changed_dimensions / dimension_values），不单列 role。
 */

export type AiModelRole =
  | 'assistant_chat'
  | 'agent_planner'
  | 'image_prompt_optimizer'
  | 'batch_planner'
  | 'vision_analysis'
  | 'vision_prompt_optimizer'
  | 'image_evaluation'
  | 'image_generation';

/** 模型来源（配置是如何决定当前模型的）。 */
export type AiModelSource = 'manual' | 'follow' | 'default' | 'fallback';

export type AiRoleGroup = 'vision' | 'creation' | 'agent';

/** role 对模型能力的最低要求（能力判断只看 capabilities，禁止按名称猜）。 */
export type AiRoleCapability = 'text' | 'vision' | 'server_image';

export interface AiRoleDefinition {
  role: AiModelRole;
  /** 设置页「AI 模型使用」中的功能名。 */
  label: string;
  /** 一句话说明该功能做什么。 */
  description: string;
  group: AiRoleGroup;
  capability: AiRoleCapability;
  /**
   * 路由可配置性：
   *  - routing：在「AI 模型使用」内直接跟随 / 单独指定
   *  - external：模型在其它设置页配置（AI 智能体 / 视觉模型），此处只读展示 + 跳转
   *  - fixed：服务端固定模型，不可配置
   */
  configurable: 'routing' | 'external' | 'fixed';
  /** 默认跟随的 role（推荐配置；follow 模式的缺省目标）。 */
  defaultFollow?: AiModelRole;
}

export const AI_MODEL_ROLES: readonly AiRoleDefinition[] = [
  {
    role: 'vision_analysis',
    label: '视觉理解',
    description: '看懂参考图的人物、动作、构图与风格，产出结构化复刻方案。',
    group: 'vision',
    capability: 'vision',
    configurable: 'external',
  },
  {
    role: 'vision_prompt_optimizer',
    label: '复刻 Prompt 优化',
    description: '理解修改意图（含人物 / 服装语义与 changed_dimensions 判定），重建最终生图 Prompt。',
    group: 'vision',
    capability: 'text',
    configurable: 'routing',
    defaultFollow: 'vision_analysis',
  },
  {
    role: 'image_evaluation',
    label: '图片结果评价',
    description: '生成完成后按任务完成度逐张评价（六维评分 + 摘要）。',
    group: 'vision',
    capability: 'vision',
    configurable: 'routing',
    defaultFollow: 'vision_analysis',
  },
  {
    role: 'image_generation',
    label: '图片生成',
    description: '文生图 / 图生图 / 批量生成的执行模型（服务端计费）。',
    group: 'creation',
    capability: 'server_image',
    configurable: 'fixed',
  },
  {
    role: 'image_prompt_optimizer',
    label: '图片 Prompt 优化',
    description: '把自然语言需求优化为专业图片提示词（含多对象批量拆分）。',
    group: 'creation',
    capability: 'text',
    configurable: 'routing',
  },
  {
    role: 'batch_planner',
    label: '批量方案规划',
    description: '批量生成时把总需求规划为 N 个不同方案。',
    group: 'creation',
    capability: 'text',
    configurable: 'routing',
    defaultFollow: 'image_prompt_optimizer',
  },
  {
    role: 'assistant_chat',
    label: '普通聊天',
    description: 'AI 智能体的对话模型；每个会话可单独切换（此处显示默认值）。',
    group: 'agent',
    capability: 'text',
    configurable: 'external',
  },
  {
    role: 'agent_planner',
    label: '任务规划',
    description: '把任务模式的需求解析为结构化执行方案（含澄清追问）。',
    group: 'agent',
    capability: 'text',
    configurable: 'external',
  },
] as const;

export const AI_ROLE_GROUP_LABELS: Record<AiRoleGroup, string> = {
  vision: '视觉与复刻',
  creation: '图片创作',
  agent: 'AI 智能体',
};

export const AI_ROLE_GROUP_ORDER: readonly AiRoleGroup[] = ['vision', 'creation', 'agent'];

export function getAiRoleDefinition(role: AiModelRole): AiRoleDefinition {
  const def = AI_MODEL_ROLES.find(item => item.role === role);
  if (!def) throw new Error(`Unknown AI model role: ${role}`);
  return def;
}

export const AI_SOURCE_LABELS: Record<AiModelSource, string> = {
  manual: '手动指定',
  follow: '跟随',
  default: '系统默认',
  fallback: '当前回退',
};

/** 服务端固定生成模型（唯一执行模型，服务端计费）。 */
export const SERVER_IMAGE_GENERATION_MODEL = {
  modelId: 'gpt-image-2',
  displayName: 'gpt-image-2',
  providerName: 'CyImagePro 服务端',
} as const;
