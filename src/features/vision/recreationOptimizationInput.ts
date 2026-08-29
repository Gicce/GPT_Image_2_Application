/**
 * 统一「有效复刻意图 → 优化输入」组装器（V6.8.1）。
 *
 * 「优化复刻 Prompt」必须把用户在整个工作流里填写的所有当前生效要求重新汇总：
 * 第 2 步需求描述（freeText 原文）+ 第 3 步素材替换（人物替换 / 服装来源 /
 * 自定义服装 / 维度参考图 / 区域替换 / 人物替换合同 V2）。
 *
 * 铁律：
 *  - 只读 Effective State：存储态里的历史残留（如切换服装来源后遗留的旧
 *    customClothing 文本）绝不进入优化输入（getEffectiveModificationDraft 负责清洗）；
 *  - 页面所有语义写入口（commitModificationDraft / 区域变更 / 人物合同变更 /
 *    optimizeRecreationPrompt）都从本模块取同一份指令，禁止组件自行拼字符串；
 *  - 绝不把 workspace / project 整体 JSON 丢给模型——只输出机器可读的指令文本。
 */

import {
  buildModificationInstruction,
  type ModificationDraft,
  type ModificationInstructionContext,
} from './modificationIntent';
import { describeRectPosition, REGION_TYPE_LABELS } from './project/region';
import { PERSON_REPLACE_SCOPE_LABELS, PERSON_STRENGTH_LABELS } from './project/personContract';
import type { VisualProject } from './project/types';

/**
 * 有效修改意图（Stored → Effective）：
 * 服装来源不是 custom 时，customClothing 一律清空——用户先填「红色制服」再切到
 * 「人物服装」后，优化器绝不能继续收到旧的「红色制服」文本。
 * 其余字段本身就是当前生效语义（freeText 原文 = 用户需求描述），原样保留。
 */
export function getEffectiveModificationDraft(draft: ModificationDraft): ModificationDraft {
  if (draft.clothingPolicy === 'custom') return draft;
  return draft.customClothing ? { ...draft, customClothing: '' } : draft;
}

/** 当前生效的区域替换（enabled 区域 + 已解析的人物参考绑定；禁用区域绝不进入优化输入）。 */
export interface EffectiveRegionReplacement {
  id: string;
  /** 用户命名的区域名（=「区域是什么」的定位锚点；精确范围以蒙版 / 矩形为准）。 */
  name: string;
  /** 替换类型（人物 / 背景 / 物体 / 自定义）。 */
  typeLabel: string;
  /** 区域范围的可读描述（矩形 = 位置 + 大小；画笔 = 蒙版）。 */
  positionLabel: string;
  /** 替换内容描述（=「替换为什么」）。 */
  prompt: string;
  /** 人物替换区域绑定的参考素材名（=「有什么参考素材」）。 */
  personReferenceLabel?: string;
  /** 人物替换区域的身份约束强度。 */
  strengthLabel?: string;
  /** 人物替换区域的替换范围。 */
  scopeLabel?: string;
}

/** 收集当前生效区域（含人物参考解析；reference 缺失时保持 undefined，不虚构绑定）。 */
export function collectEffectiveRegionReplacements(
  project: VisualProject | null | undefined,
): EffectiveRegionReplacement[] {
  if (!project) return [];
  return project.regions
    .filter(region => region.enabled)
    .map(region => {
      const personRef = region.replaceType === 'person' && region.personReferenceId
        ? project.references.find(ref => ref.id === region.personReferenceId)
        : undefined;
      return {
        id: region.id,
        name: region.name?.trim() || '未命名区域',
        typeLabel: REGION_TYPE_LABELS[region.replaceType] ?? '自定义',
        positionLabel: region.shape.kind === 'rect'
          ? describeRectPosition(region.shape)
          : '画笔蒙版范围',
        prompt: region.prompt?.trim() ?? '',
        personReferenceLabel: personRef?.label?.trim() || undefined,
        strengthLabel: region.replaceType === 'person'
          ? PERSON_STRENGTH_LABELS[region.constraintStrength]
          : undefined,
        scopeLabel: region.replaceType === 'person' && region.replaceScope
          ? PERSON_REPLACE_SCOPE_LABELS[region.replaceScope]
          : undefined,
      };
    });
}

/**
 * 区域替换指令块：逐区域写明「区域是什么 / 替换为什么 / 有什么参考素材」，
 * 绝不只给一个区域计数（V6.8.1 修复：优化后的最终 Prompt 必须真实携带区域要求）。
 */
export function buildRegionReplacementLines(
  project: VisualProject | null | undefined,
): string[] {
  const regions = collectEffectiveRegionReplacements(project);
  if (regions.length === 0) return [];
  const lines = regions.map((region, index) => {
    const parts = [
      `区域 ${index + 1}「${region.name}」［${region.typeLabel}；范围：${region.positionLabel}`,
    ];
    if (region.strengthLabel) parts.push(`身份强度=${region.strengthLabel}`);
    if (region.scopeLabel) parts.push(`替换范围=${region.scopeLabel}`);
    let line = parts.join('；') + '］';
    if (region.personReferenceLabel) {
      line += `人物身份以参考图「${region.personReferenceLabel}」为准；`;
    }
    line += `：替换为——${region.prompt || '（按区域类型自洽设计，需与画面整体不冲突）'}`;
    return `- ${line}`;
  });
  return [
    `区域替换（逐区域执行，共 ${regions.length} 个；区域范围以蒙版 / 矩形为准，区域外画面严格保持画面模板）：`,
    ...lines,
  ];
}

/**
 * 人物替换合同 V2 指令行（强度 / 替换范围 / 身份应用来自项目合同）。
 * 硬性合同块（optimizerContract）声明「优化器无权裁决」；本行进入【用户调整要求】
 * 让优化器把用户实际选择的强度语义真实写进最终 Prompt。
 * 合同 V2 任何字段变化都会改变本行 → 统一指令变化 → needsOptimization（V6.8.1）。
 */
export function buildPersonContractLines(
  project: VisualProject | null | undefined,
): string[] {
  const person = project?.modification.person;
  if (!person?.enabled) return [];
  const lines: string[] = [];
  const scopeLabel = person.replaceScope === 'custom_region'
    ? person.targetRegionId ? '指定区域（以区域合同为准）' : '指定区域（区域待选择）'
    : PERSON_REPLACE_SCOPE_LABELS[person.replaceScope];
  lines.push(
    `人物替换合同：强度=${PERSON_STRENGTH_LABELS[person.strength]}；替换范围=${scopeLabel}`
    + `；身份应用=${person.applyIdentityTo === 'all_corresponding_subjects' ? '所有对应主体' : '仅主主体'}`,
  );
  return lines;
}

/**
 * 统一优化输入指令（唯一组装入口）：
 * 有效修改意图的合成指令（需求描述 + 维度 + 人物 + 服装策略 + 参考图 + 复刻强度）
 * ＋ 区域替换块 ＋ 人物替换合同 V2 行。
 * 任何一部分变化 → 指令字符串变化 → semanticRevision 派生 needsOptimization。
 */
export function buildRecreationOptimizationInstruction(
  draft: ModificationDraft,
  project: VisualProject | null | undefined,
  context?: ModificationInstructionContext,
): string {
  return [
    buildModificationInstruction(getEffectiveModificationDraft(draft), context),
    ...buildRegionReplacementLines(project),
    ...buildPersonContractLines(project),
  ]
    .filter(section => section.trim())
    .join('\n');
}
