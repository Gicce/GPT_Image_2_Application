/**
 * Model UI Policy（V4.0.9）—— 模型选择场景展示策略的唯一事实源。
 *
 * 选择器（ModelPicker / 视觉理解页等）只消费本模块的分组结果，
 * 禁止在页面组件内散落过滤 / 排序 / 白名单逻辑。
 *
 * 数据依据（禁止按模型名称字符串猜测能力）：
 *  - lifecycle：retired / missing → 完全隐藏；deprecated → 仅进「更多模型」并标注
 *  - enabled / use_scopes.chat → 任一不满足完全隐藏
 *  - registry recommended 标记（数据侧人工策展：新增推荐模型只改 JSON，不改代码）
 *  - 当前会话选中项与 profile.default_model_id → 永远置顶常用区
 *
 * 分组目标：每个 Provider 默认约 3～6 个常用模型；其余全部保留在「更多模型」，
 * 不丢失高级模型入口。
 */
import type { AIProviderModel, AIProviderType } from './types';
import { defaultUseScopes } from './types';
import { getBuiltInRegistry } from './registry/registry';

/** 常用区最少展示数（可用模型不足时自然少于此值） */
export const MODEL_PICKER_PRIMARY_MIN = 3;
/** 常用区最多展示数 */
export const MODEL_PICKER_PRIMARY_MAX = 6;

/** 是否应从模型选择场景完全隐藏（已下线 / 已停止发现 / 已禁用 / 不在 AI 对话使用范围） */
export function isModelHiddenFromPicker(
  model: Pick<AIProviderModel, 'lifecycle' | 'enabled' | 'use_scopes'>,
): boolean {
  if (model.lifecycle === 'retired' || model.lifecycle === 'missing') return true;
  if (!model.enabled) return true;
  return !(model.use_scopes ?? defaultUseScopes()).chat;
}

/** registry 声明的推荐模型 id（仅 active 生命周期；第三方无 registry 返回空） */
export function getRecommendedModelIds(providerType: AIProviderType): string[] {
  const registry = getBuiltInRegistry(providerType);
  if (!registry) return [];
  return registry.models
    .filter(entry => entry.recommended && entry.lifecycle === 'active')
    .map(entry => entry.model_id);
}

export interface ModelPickerSplit {
  /** 常用模型：选中项 + 默认模型 + registry 推荐，不足 MIN 时按可用性补齐 */
  primary: AIProviderModel[];
  /** 更多模型：其余 active 模型 + deprecated 模型（UI 侧标注「即将弃用」） */
  secondary: AIProviderModel[];
}

export interface ModelPickerProfileInput {
  provider_type: AIProviderType;
  default_model_id: string;
  models: AIProviderModel[];
}

/**
 * 单 Provider 模型分组。
 *
 * 常用区种子顺序：当前选中 → 默认模型 → registry 推荐（按 registry 顺序）；
 * 种子不足 MIN 时按「测试通过优先 → 目录原顺序」补齐；上限 MAX。
 * deprecated 永不进常用区。
 */
export function splitModelsForPicker(
  profile: ModelPickerProfileInput,
  activeModelId?: string,
): ModelPickerSplit {
  const visible = profile.models.filter(model => !isModelHiddenFromPicker(model));
  const activeModels = visible.filter(model => model.lifecycle !== 'deprecated');
  const deprecatedModels = visible.filter(model => model.lifecycle === 'deprecated');

  const recommendedIds = getRecommendedModelIds(profile.provider_type);
  const activeById = new Map(activeModels.map(model => [model.model_id, model]));

  const seedIds: string[] = [];
  for (const id of [activeModelId || '', profile.default_model_id, ...recommendedIds]) {
    if (id && activeById.has(id) && !seedIds.includes(id)) seedIds.push(id);
  }

  if (seedIds.length < MODEL_PICKER_PRIMARY_MIN) {
    // 补齐候选：测试通过的模型优先，其余保持目录顺序（stable）
    const filler = activeModels
      .filter(model => !seedIds.includes(model.model_id))
      .sort((a, b) => {
        const rank = (m: AIProviderModel) => (m.test_status === 'available' ? 0 : 1);
        return rank(a) - rank(b);
      });
    for (const model of filler) {
      if (seedIds.length >= MODEL_PICKER_PRIMARY_MIN) break;
      seedIds.push(model.model_id);
    }
  }

  const primary = seedIds
    .slice(0, MODEL_PICKER_PRIMARY_MAX)
    .map(id => activeById.get(id)!)
    .filter(Boolean);
  const primaryIds = new Set(primary.map(model => model.model_id));
  const secondary = [
    ...activeModels.filter(model => !primaryIds.has(model.model_id)),
    ...deprecatedModels,
  ];

  return { primary, secondary };
}
