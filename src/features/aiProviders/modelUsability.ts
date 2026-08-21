/**
 * 模型可用性统一判定（V4.0.7）—— 业务页面模型准入的唯一事实源。
 *
 * 模型中心（AIProviderStore 持久化数据）是唯一事实源：
 *  - 可用性 = lifecycle 未下线/未停止发现 + 档案启用 + 模型启用 + 测试通过（test_status='available'）；
 *  - 视觉准入 = 可用 + capabilities 显式含 'vision'（unknown / 未声明保守拦截，不进业务页）；
 *  - 禁止在业务页面按模型名称字符串猜测能力，禁止页面自维护可用模型列表。
 *
 * 状态语义映射（对齐需求口径）：
 *  - available  可用（测试通过，可进业务模型选择器）
 *  - untested   待测试（新模型 / 连接配置变更后失效，重新测试成功前不进业务列表）
 *  - testing    检测中
 *  - failed     测试失败（含 429 限流等暂时异常：模型保留在模型管理，可重新测试恢复）
 *  - disabled   已禁用（档案或模型任一层禁用）
 *  - removed    已删除/已下线（retired=官方下线；missing=Provider 已不再提供）
 */

import type { AIProviderModel, AIProviderProfile } from './types';
import { profileCategory } from './types';

export type ModelUsabilityStatus =
  | 'available'
  | 'untested'
  | 'testing'
  | 'failed'
  | 'disabled'
  | 'removed';

/** 单模型可用性判定（不含能力维度；profile 只需 enabled 判定所需字段）。 */
export function describeModelUsability(
  profile: Pick<AIProviderProfile, 'enabled'>,
  model: AIProviderModel,
): ModelUsabilityStatus {
  if (model.lifecycle === 'retired' || model.lifecycle === 'missing') return 'removed';
  if (!profile.enabled || !model.enabled) return 'disabled';
  if (model.test_status === 'failed') return 'failed';
  if (model.test_status === 'testing') return 'testing';
  if (model.test_status === 'untested') return 'untested';
  return 'available';
}

/** 模型当前是否可作为业务可用模型（测试通过 + 启用链完整）。 */
export function isModelUsable(
  profile: Pick<AIProviderProfile, 'enabled'>,
  model: AIProviderModel,
): boolean {
  return describeModelUsability(profile, model) === 'available';
}

/**
 * 视觉理解业务准入：可用 + capabilities 显式声明图片视觉。
 * 测试通过与适用于视觉业务是两个维度 —— 文本模型测试再成功也不进视觉页面。
 */
export function isModelAvailableForVision(
  profile: Pick<AIProviderProfile, 'enabled'>,
  model: AIProviderModel,
): boolean {
  return isModelUsable(profile, model) && (model.capabilities ?? []).includes('vision');
}

export interface UsableVisionModelOption {
  profileId: string;
  profileName: string;
  modelId: string;
  displayName: string;
  model: AIProviderModel;
}

/**
 * 视觉理解页面下拉列表唯一来源：vision 类别档案中所有「可用 + 支持图片视觉」的模型。
 * 档案禁用 / 模型禁用 / 未测试 / 测试失败 / 已下线 / 无视觉能力一律不出现。
 */
export function getAvailableVisionModels(profiles: AIProviderProfile[]): UsableVisionModelOption[] {
  return profiles
    .filter(profile => profileCategory(profile) === 'vision')
    .flatMap(profile =>
      profile.models
        .filter(model => isModelAvailableForVision(profile, model))
        .map(model => ({
          profileId: profile.id,
          profileName: profile.name,
          modelId: model.model_id,
          displayName: model.display_name || model.model_id,
          model,
        })),
    );
}

/**
 * 恢复已保存的模型选择：原选择仍满足可用列表 → 保留；
 * 否则回落到列表第一个；列表为空 → 置空（禁止恢复任何失效模型 ID）。
 */
export function resolveModelSelectionOrFirst(
  stored: { profileId: string; modelId: string },
  options: Array<{ profileId: string; modelId: string }>,
): { profileId: string; modelId: string } {
  if (options.some(o => o.profileId === stored.profileId && o.modelId === stored.modelId)) {
    return { profileId: stored.profileId, modelId: stored.modelId };
  }
  const first = options[0];
  return first ? { profileId: first.profileId, modelId: first.modelId } : { profileId: '', modelId: '' };
}

/**
 * 连接配置变更 → 测试状态失效（store mutation 路径调用）。
 * API Key / Base URL / Provider / Model ID 任一变化后，旧的「测试通过」不再可信：
 * 复位为 untested（保留检测时间线字段），重新测试成功前业务页面不再放行。
 * 传 rowId 只失效单个模型（如 custom 模型改 model_id），否则失效整个目录。
 */
export function invalidateModelTestStatus(
  models: AIProviderModel[],
  rowId?: string,
): AIProviderModel[] {
  return models.map(model =>
    rowId && model.id !== rowId
      ? model
      : {
          ...model,
          test_status: 'untested',
          last_error_code: undefined,
          last_error_message: undefined,
          last_error_status: undefined,
        },
  );
}
