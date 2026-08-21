/**
 * 视觉理解携带草稿 → 图片工作室状态补丁（V4.0.8，纯函数）。
 *
 * 规则（视觉理解不再强制文生图）：
 *  - 草稿显式带 generationMode → 按草稿；
 *  - 未指定但有原图（sourceImagePath）→ 默认图生图（复刻 / 人物锁定优先，
 *    不写死任何关键词判断）；
 *  - 无原图 → 文生图。
 * 图生图时视觉理解原图直接作为参考图路径进入 i2iSources（复用既有本地文件，
 * 不复制、不重新导入、不创建重复素材）；Prompt / 负面词 / 尺寸 / 质量 / 数量
 * 一并带入，页面打开即完整状态，不需要用户重选。
 */

import type { VisionCarryDraft } from '../../store/useDraftStore';

export interface StudioSourceImage {
  path: string;
  name: string;
}

export interface StudioCarryPatch {
  generationType: 't2i' | 'i2i';
  generationMode: 'single';
  /** 图生图：参考图列表（当前 = 视觉理解原图，单张）。 */
  i2iSources: StudioSourceImage[];
  /** 图生图：编辑需求预填（= 复刻最终 Prompt）。 */
  i2iPrompt: string;
  /** 文生图：提示词与负面词预填。 */
  t2iPrompt: string;
  t2iNegative: string;
  size?: string;
  quality?: string;
}

/** 生成方式默认策略：有原图 → 图生图；无原图 → 文生图（用户始终可手动切换）。 */
export function resolveCarryGenerationMode(
  carry: Pick<VisionCarryDraft, 'generationMode' | 'sourceImagePath'>,
): 't2i' | 'i2i' {
  if (carry.generationMode === 't2i' || carry.generationMode === 'i2i') {
    return carry.generationMode;
  }
  return carry.sourceImagePath?.trim() ? 'i2i' : 't2i';
}

export function resolveVisionCarryPatch(carry: VisionCarryDraft): StudioCarryPatch {
  const generationType = resolveCarryGenerationMode(carry);
  const sourcePath = carry.sourceImagePath?.trim() || '';
  const prompt = carry.prompt.trim();
  const negative = carry.negativePrompt?.trim() || '';
  return {
    generationType,
    generationMode: 'single',
    i2iSources: generationType === 'i2i' && sourcePath
      ? [{ path: sourcePath, name: sourcePath.split(/[\\/]/).pop() || sourcePath }]
      : [],
    i2iPrompt: generationType === 'i2i' ? prompt : '',
    t2iPrompt: generationType === 't2i' ? prompt : '',
    t2iNegative: generationType === 't2i' ? negative : '',
    size: carry.size,
    quality: carry.quality,
  };
}
