/**
 * Role 能力过滤（V4.1）—— 「AI 模型使用」ModelPicker 分组唯一来源。
 *
 * 能力判断只看 capabilities（禁止按模型名称猜）；已下线 / 已停止发现 / 已停用
 * 的模型一律不出现。纯函数，供设置页与测试共用。
 */

import type { AIProviderModel, AIProviderProfile, AIProviderType, BillingMode } from '../aiProviders/types';
import type { AiModelRole } from './modelRoles';
import { getAiRoleDefinition } from './modelRoles';

export interface RolePickerGroup {
  profile: {
    id: string;
    name: string;
    provider_type: AIProviderType;
    billing_mode?: BillingMode;
    default_model_id: string;
  };
  models: AIProviderModel[];
}

function supportsTextUse(model: AIProviderModel): boolean {
  const caps = model.capabilities ?? [];
  if (caps.length === 0 || caps.includes('unknown')) return true;
  const generationOnly =
    caps.includes('image_generation') || caps.includes('image_edit') || caps.includes('video_generation');
  return !(generationOnly && !caps.includes('text'));
}

function allowsVisionUse(model: AIProviderModel): boolean {
  const caps = model.capabilities ?? [];
  if (caps.length === 0 || caps.includes('unknown')) return true;
  return caps.includes('vision');
}

/** 单模型是否满足 role 能力要求（text=可文本调用；vision=可图片输入）。 */
export function modelSatisfiesRole(role: AiModelRole, model: AIProviderModel): boolean {
  if (model.lifecycle === 'retired' || model.lifecycle === 'missing' || !model.enabled) return false;
  const capability = getAiRoleDefinition(role).capability;
  if (capability === 'vision') return allowsVisionUse(model);
  if (capability === 'text') return supportsTextUse(model);
  return false;
}

/** 全部启用档案 → 按 role 能力过滤的 Picker 分组（空分组剔除）。 */
export function buildRolePickerGroups(role: AiModelRole, profiles: AIProviderProfile[]): RolePickerGroup[] {
  return profiles
    .filter(profile => profile.enabled)
    .map(profile => ({
      profile: {
        id: profile.id,
        name: profile.name,
        provider_type: profile.provider_type,
        billing_mode: profile.billing_mode,
        default_model_id: profile.default_model_id,
      },
      models: profile.models.filter(model => modelSatisfiesRole(role, model)),
    }))
    .filter(group => group.models.length > 0);
}
