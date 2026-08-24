/**
 * 视觉理解携带草稿 → 图片工作室状态补丁（V4.0.8，纯函数；V4.0.9.1 人物强替换升级）。
 *
 * 规则（视觉理解不再强制文生图）：
 *  - 草稿显式带 generationMode → 按草稿；
 *  - 未指定但有原图（sourceImagePath）→ 默认图生图（复刻 / 人物锁定优先，
 *    不写死任何关键词判断）；
 *  - 无原图 → 文生图。
 * 图生图时参考图按 **带角色清单**（carry.imageReferences，顺序 = 最终提交顺序：
 * template → person_reference → extras）进入 i2iSources（复用既有本地文件，
 * 不复制、不重新导入、不创建重复素材）；Prompt / 负面词 / 尺寸 / 质量 / 数量
 * 一并带入，页面打开即完整状态，不需要用户重选。
 *
 * V4.0.9.1 关键保证：i2i 携带时，把「图片使用说明（强制执行）」确定性编译进
 * i2iPrompt 前部（人物身份来自人物参考图 / 排除模板人物身份 / 服装来源分离），
 * 并把「模板图原人物脸部身份」追加进负面提示词——不依赖优化器模型自觉，
 * gpt-image-2 收到的 prompt 一定声明每张附图的职责。
 */

import type { GenerationImageReference } from '../../types';
import type { VisionCarryDraft } from '../../store/useDraftStore';
import type { ClothingPolicy } from './modificationIntent';
import {
  appendNegativeAddendum,
  buildGenerationImageDirective,
  buildGenerationNegativeAddendum,
  type GenerationDirectiveInput,
} from './generationDirective';

export interface StudioSourceImage {
  path: string;
  name: string;
}

export interface StudioCarryPatch {
  generationType: 't2i' | 'i2i';
  generationMode: 'single';
  /** 图生图：参考图列表（顺序 = 提交顺序：模板 → 人物 → 其余参考）。 */
  i2iSources: StudioSourceImage[];
  /** 图生图：编辑需求预填（= 图片使用说明指令块 + 复刻最终 Prompt）。 */
  i2iPrompt: string;
  /** 图生图：负面提示词（含模板人物身份排斥追加项）。 */
  i2iNegative: string;
  /** 文生图：提示词与负面词预填。 */
  t2iPrompt: string;
  t2iNegative: string;
  size?: string;
  quality?: string;
  /** V4.1 Region V1：区域合成 mask（进入 create_task.mask_image → edits `mask` 部件）。 */
  maskImagePath?: string;
}

/** 生成方式默认策略：有原图（含角色清单）→ 图生图；无原图 → 文生图（用户始终可手动切换）。 */
export function resolveCarryGenerationMode(
  carry: Pick<VisionCarryDraft, 'generationMode' | 'sourceImagePath' | 'imageReferences'>,
): 't2i' | 'i2i' {
  if (carry.generationMode === 't2i' || carry.generationMode === 'i2i') {
    return carry.generationMode;
  }
  if (carry.sourceImagePath?.trim()) return 'i2i';
  // 带角色的参考图清单本身即「有图」证据（人物参考 / 额外参考不能因缺 sourceImagePath 被静默丢弃）
  return (carry.imageReferences ?? []).some(ref => ref.path?.trim()) ? 'i2i' : 't2i';
}

/**
 * carry → 带角色的参考图清单（顺序 = 提交顺序）。
 * 新 carry 显式带 imageReferences；旧 / 手写 carry 回落 sourceImagePath +
 * personReferencePath 两路径（保持兼容）。归一化路径去重，模板与人物路径不同
 * ⇒ 两张都存活（绝不因同任务 / 同目录 / 前后斜杠差异误删人物图）。
 */
export function resolveCarryImageReferences(
  carry: VisionCarryDraft,
): GenerationImageReference[] {
  if (carry.imageReferences?.length) {
    const seen = new Set<string>();
    const refs: GenerationImageReference[] = [];
    for (const ref of carry.imageReferences) {
      const key = (ref.path || '').trim().replace(/\\/g, '/').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
    return refs;
  }
  const refs: GenerationImageReference[] = [];
  const sourcePath = carry.sourceImagePath?.trim();
  const personPath = carry.personReferencePath?.trim();
  if (sourcePath) refs.push({ path: sourcePath, label: '原图', role: 'template' });
  if (personPath && personPath.replace(/\\/g, '/').toLowerCase() !== sourcePath?.replace(/\\/g, '/').toLowerCase()) {
    refs.push({ path: personPath, label: '人物参考', role: 'person_reference' });
  }
  return refs;
}

function normalizePathKey(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase();
}

export function resolveVisionCarryPatch(carry: VisionCarryDraft): StudioCarryPatch {
  const generationType = resolveCarryGenerationMode(carry);
  const prompt = carry.prompt.trim();
  const negative = carry.negativePrompt?.trim() || '';
  const refs = resolveCarryImageReferences(carry);
  const toSource = (path: string): StudioSourceImage => ({
    path,
    name: path.split(/[\\/]/).pop() || path,
  });

  // i2i：按角色清单构建参考图（模板 → 人物 → 其余参考），确定性编译图片使用说明。
  // V4.1：carry.promptCompiled = Prompt Compiler 已分层编译全部合同块（图片角色 /
  // 人物 / 区域 / 媒介 / 服装 / 维度 / 模板保留），此处只装配参考图清单，
  // 绝不二次前置指令（禁止同一合同在 prompt 里出现两份）。
  const i2iSources: StudioSourceImage[] = [];
  let i2iPrompt = '';
  let i2iNegative = '';
  if (generationType === 'i2i') {
    const directiveInput: GenerationDirectiveInput = {
      imageReferences: refs,
      personReplacementEnabled: carry.personReplacement?.enabled
        ?? refs.some(ref => ref.role === 'person_reference'),
      clothingPolicy: (carry.personReplacement?.clothingPolicy as ClothingPolicy | undefined) ?? 'preserve_original',
      customClothing: carry.personReplacement?.customClothing,
    };
    const alreadyCompiled = carry.promptCompiled === true;
    const directive = alreadyCompiled ? '' : buildGenerationImageDirective(directiveInput);
    const seen = new Set<string>();
    for (const ref of refs) {
      const key = normalizePathKey(ref.path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      i2iSources.push(toSource(ref.path));
    }
    i2iPrompt = directive ? `${directive}\n\n${prompt}` : prompt;
    i2iNegative = alreadyCompiled
      ? negative
      : appendNegativeAddendum(negative, buildGenerationNegativeAddendum(directiveInput));
  }
  return {
    generationType,
    generationMode: 'single',
    i2iSources,
    i2iPrompt,
    i2iNegative,
    t2iPrompt: generationType === 't2i' ? prompt : '',
    t2iNegative: generationType === 't2i' ? negative : '',
    size: carry.size,
    quality: carry.quality,
    ...(carry.maskImagePath?.trim() ? { maskImagePath: carry.maskImagePath.trim() } : {}),
  };
}
