/**
 * 人物替换「当前替换规则」摘要（V4.1 视觉映射版）。
 *
 * 纯函数：从真实配置（person / clothingPolicy / customClothing）派生
 * 「替换什么 ← 来自谁」的一眼可读规则表，供面板底部轻量 Summary 渲染。
 * 绝不写死——配置变化即重新派生；无人物时返回 null（不渲染）。
 */

import { personHasImage, type ClothingPolicy, type PersonReplacement } from './modificationIntent';

/** 摘要中的一行：维度组 → 来源（@token 或文字）。 */
export interface ReplacementRuleRow {
  /** 维度组名（替换 / 服装 / 修改 / 保留）。 */
  kind: 'replace' | 'clothing' | 'modify' | 'keep';
  /** 该行覆盖的维度（身份 / 五官 / 发型…）。 */
  items: string[];
  /** 来源展示（@人物参考 / @原图 / 自定义 / 说明文字）。 */
  source: string;
  /** 来源是否为用户可点击的 mention 风格 token。 */
  isToken: boolean;
}

export interface ReplacementSummaryModel {
  rows: ReplacementRuleRow[];
}

/** 摘要行来源标签。 */
export const REPLACEMENT_SUMMARY_LABELS = {
  replaceKind: '替换',
  clothingKind: '服装',
  modifyKind: '修改',
  keepKind: '保留',
  personToken: '@人物参考',
  personDescription: '人物描述',
  originalToken: '@原图',
  customSource: '自定义',
  poseModifyNote: '因已启用「修改动作」，将在原图基础上生成新的动作变化',
  sceneModifyNote: '因已启用「修改背景」，将在保留画面风格的前提下重新调整背景内容',
  cameraModifyNote: '因已启用「修改镜头」，镜头语言将按整体意图调整',
  styleModifyNote: '因已启用「修改风格」，画面风格将按整体意图调整',
} as const;

/** 人物替换规则摘要：无人物（含纯文字描述未填）返回 null。 */
export function buildReplacementSummary(input: {
  person: PersonReplacement | null;
  clothingPolicy: ClothingPolicy;
  customClothing?: string;
  /** 已启用的修改维度（动作 / 背景等 Chip；决定「修改」与「保留」行的真实内容）。 */
  activeDimensions?: ReadonlyArray<'subject' | 'clothing' | 'pose' | 'scene' | 'camera' | 'style'>;
}): ReplacementSummaryModel | null {
  const { person, clothingPolicy, customClothing, activeDimensions = [] } = input;
  if (!person) return null;

  const rows: ReplacementRuleRow[] = [];
  const poseEnabled = activeDimensions.includes('pose');
  const sceneEnabled = activeDimensions.includes('scene');
  const styleEnabled = activeDimensions.includes('style');

  // 替换行：人物特征 ← 人物来源（参考图 / 描述）
  rows.push({
    kind: 'replace',
    items: ['主体人物', '面部 / 五官', '发型'],
    source: personHasImage(person) ? REPLACEMENT_SUMMARY_LABELS.personToken : REPLACEMENT_SUMMARY_LABELS.personDescription,
    isToken: true,
  });

  // 服装行：由服装策略真实派生
  if (clothingPolicy === 'use_subject_reference') {
    rows.push({
      kind: 'clothing',
      items: ['服装'],
      source: REPLACEMENT_SUMMARY_LABELS.personToken,
      isToken: true,
    });
  } else if (clothingPolicy === 'custom') {
    rows.push({
      kind: 'clothing',
      items: ['服装'],
      source: customClothing?.trim() ? '自定义' : '自定义（未填写）',
      isToken: false,
    });
  } else {
    rows.push({
      kind: 'clothing',
      items: ['服装'],
      source: REPLACEMENT_SUMMARY_LABELS.originalToken,
      isToken: true,
    });
  }

  // 修改行：已启用维度动态派生（启用 = 必须真实修改）
  if (poseEnabled) {
    rows.push({ kind: 'modify', items: ['动作'], source: REPLACEMENT_SUMMARY_LABELS.poseModifyNote, isToken: false });
  }
  if (sceneEnabled) {
    rows.push({ kind: 'modify', items: ['背景'], source: REPLACEMENT_SUMMARY_LABELS.sceneModifyNote, isToken: false });
  }
  if (activeDimensions.includes('camera')) {
    rows.push({ kind: 'modify', items: ['镜头'], source: REPLACEMENT_SUMMARY_LABELS.cameraModifyNote, isToken: false });
  }
  if (styleEnabled) {
    rows.push({ kind: 'modify', items: ['风格'], source: REPLACEMENT_SUMMARY_LABELS.styleModifyNote, isToken: false });
  }

  // 保留行：画面结构 ← 原图（画面模板）；已启用修改的维度从保留行剔除
  const keepItems = ['构图', sceneEnabled ? null : '背景', styleEnabled ? null : '风格'].filter(Boolean) as string[];
  rows.push({
    kind: 'keep',
    items: keepItems,
    source: REPLACEMENT_SUMMARY_LABELS.originalToken,
    isToken: true,
  });

  return { rows };
}
