/**
 * Detail Insert Instance（V5 Group/Instance 分离）—— 实例解析与完整性校验。
 *
 * 历史缺陷（本轮 Root Cause）：RenderingRegion 是「媒介层」，一个 detail_insert
 * 层实际覆盖多个相框 / 特写框，Region Count != Actual Insert Count——
 * 「检测到 1 个动漫 detail inserts」由此而来。
 *
 * 本模块职责：
 *  - 实例解析唯一入口 instancesOfRegion（模型直出 instances > 组级单实例兜底）；
 *  - Analysis Validator（§7）：层描述含多插图信号但实例数 ≤ 1 ⇒ 标记
 *    detail_insert_instances_incomplete（不默认二次 AI 调用）；
 *  - 受限 Repair 合并（§8）：只补 instances，绝不重写 TemplateSnapshot 其它字段。
 */

import type {
  DetailInsertCropType,
  DetailInsertInstance,
  RenderingContract,
  RenderingRegion,
  VisualTemplateSnapshot,
} from './types';
import { deriveDetailInsertCropType } from './rendering';

/** 层描述中的多插图信号（命中 ⇒ 该层的实例数必须 > 1 才算完整）。 */
const MULTI_INSERT_SIGNAL_PATTERNS: RegExp[] = [
  /多个|数个|若干|几处|多幅|多张|多枚|多个不同的/,
  /两[个处张幅]|三[个处张幅]|四[个处张幅]|五[个处张幅]/,
  /四角|四边|两侧|两边|上下[两方角]?|左右[两方]?(?:各|分别)|各[一角边](?:均|都|处)?/,
  /multiple|several|panels|frames|inserts/i,
];

/** 单句/单描述是否声明了「多个插图」。 */
export function descriptionDeclaresMultipleInserts(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return MULTI_INSERT_SIGNAL_PATTERNS.some(pattern => pattern.test(trimmed));
}

export interface InsertInstancesResolution {
  /** 该层的有效实例清单（模型直出 > 组级单实例兜底）。 */
  instances: DetailInsertInstance[];
  /** 兜底合成的单实例（旧快照兼容路径；true = 无结构化实例数据）。 */
  synthesizedFallback: boolean;
  /** 层描述声明多个插图但实例数 ≤ 1 ⇒ 分析不完整（生成前阻断 / 触发受限 repair）。 */
  incomplete: boolean;
}

/**
 * 实例解析唯一入口（编译 / 校验 / Trace 共用；组件不得自行遍历 region.instances）。
 *  - region.instances 非空 ⇒ 直接使用（一个画框 = 一个 instance）；
 *  - 空且层描述含多插图信号 ⇒ incomplete（绝不把「层」伪装成 1 个实例）；
 *  - 空且无多插图信号 ⇒ 组级单实例兜底（旧快照 = 层即一个插图，保持既有语义）。
 */
export function instancesOfRegion(region: RenderingRegion): InsertInstancesResolution {
  if (region.semanticRole !== 'detail_insert') {
    return { instances: [], synthesizedFallback: false, incomplete: false };
  }
  const direct = Array.isArray(region.instances) ? region.instances : [];
  if (direct.length > 0) {
    return { instances: direct, synthesizedFallback: false, incomplete: false };
  }
  const declaresMultiple = descriptionDeclaresMultipleInserts(
    `${region.label} ${region.description ?? ''}`);
  if (declaresMultiple) {
    return { instances: [], synthesizedFallback: false, incomplete: true };
  }
  const cropType = region.cropType ?? deriveDetailInsertCropType(region);
  const instance: DetailInsertInstance = {
    id: `${region.id}-ins-1`,
    groupId: region.id,
    mediaType: region.renderingMode,
    cropType,
    label: region.label,
    ...(region.description?.trim() ? { description: region.description.trim() } : {}),
  };
  return { instances: [instance], synthesizedFallback: true, incomplete: false };
}

/** 全部 detail_insert 层的实例展平（顺序 = regions 顺序）。 */
export function allInsertInstances(contract: RenderingContract | null | undefined): Array<{
  region: RenderingRegion;
  resolution: InsertInstancesResolution;
}> {
  const regions = contract?.overallMode === 'mixed_media' ? contract.regions : [];
  return regions
    .filter(region => region.semanticRole === 'detail_insert')
    .map(region => ({ region, resolution: instancesOfRegion(region) }));
}

export interface InsertInstanceCounts {
  /** 插图实例总数（instance 口径，非层口径）。 */
  total: number;
  /** 动漫媒介实例数（绑定 Canonical Character 的候选）。 */
  anime: number;
  /** 真人媒介实例数（镜像真人主体，绝不绑动漫角色卡）。 */
  photographic: number;
  /** 其它媒介实例数（插画 / 3D / 图形贴纸）。 */
  other: number;
  /** 存在不完整层（多插图声明 + 实例缺失）。 */
  incompleteRegions: RenderingRegion[];
}

/** 插图实例计数（Skill Trace / 确认摘要 / 校验共用）。 */
export function countInsertInstances(contract: RenderingContract | null | undefined): InsertInstanceCounts {
  const entries = allInsertInstances(contract);
  const counts: InsertInstanceCounts = {
    total: 0, anime: 0, photographic: 0, other: 0, incompleteRegions: [],
  };
  for (const { region, resolution } of entries) {
    if (resolution.incomplete) counts.incompleteRegions.push(region);
    counts.total += resolution.instances.length;
    for (const instance of resolution.instances) {
      if (instance.mediaType === 'anime_illustration') counts.anime += 1;
      else if (instance.mediaType === 'photorealistic') counts.photographic += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

/**
 * 受限 Detail Insert Extraction Repair 合并（§8）：
 * 把 repair 提取的实例清单合入模板快照对应 detail_insert 层——
 * 只碰 regions[].instances，模板九维度 / subjectPoses / 层结构原样保留。
 * 返回新快照（原快照不可变）。
 */
export function applyDetailInsertInstances(
  snapshot: VisualTemplateSnapshot,
  regionId: string,
  instances: Array<Pick<DetailInsertInstance, 'label' | 'cropType' | 'mediaType'> & Partial<DetailInsertInstance>>,
): VisualTemplateSnapshot {
  const media = snapshot.mediaStructure;
  if (!media) return snapshot;
  const regions = media.regions.map(region => {
    if (region.id !== regionId || region.semanticRole !== 'detail_insert') return region;
    const normalized: DetailInsertInstance[] = instances.map((instance, index) => ({
      id: `${region.id}-ins-${index + 1}`,
      groupId: region.id,
      mediaType: instance.mediaType,
      cropType: instance.cropType as DetailInsertCropType | 'body',
      ...(instance.bounds ? { bounds: instance.bounds } : {}),
      ...(instance.targetSubjectRole ? { targetSubjectRole: instance.targetSubjectRole } : {}),
      label: instance.label,
      ...(instance.description ? { description: instance.description } : {}),
    }));
    return { ...region, instances: normalized };
  });
  return { ...snapshot, mediaStructure: { ...media, regions } };
}

/** 单层提取结果（IO 层产出；instances 为空/null = 该层识别失败，绝不清空旧分析）。 */
export interface DetailInsertRepairInput {
  regionId: string;
  instances: Array<Pick<DetailInsertInstance, 'label' | 'cropType' | 'mediaType'> & Partial<DetailInsertInstance>> | null;
}

export interface DetailInsertRepairOutcome {
  /** 合并后的模板快照（repaired = 0 时与入参同一引用，绝不产出半成品）。 */
  snapshot: VisualTemplateSnapshot;
  repaired: number;
  failed: number;
  /** 合并后全项目的实例计数（成功提示 / Rail 展示口径）。 */
  after: InsertInstanceCounts;
}

/**
 * 受限补充识别的合并唯一入口（纯函数；页面只负责逐层调用视觉提取 IO）：
 *  - 只通过 applyDetailInsertInstances 碰 regions[].instances；
 *  - 全部失败（repaired = 0）⇒ 原快照原样返回（旧分析绝不丢失）；
 *  - 部分失败 ⇒ 已成功层照常合入（下次只补剩余层）。
 */
export function mergeDetailInsertRepairResults(
  snapshot: VisualTemplateSnapshot,
  results: DetailInsertRepairInput[],
): DetailInsertRepairOutcome {
  let merged = snapshot;
  let repaired = 0;
  let failed = 0;
  for (const result of results) {
    if (result.instances && result.instances.length > 0) {
      merged = applyDetailInsertInstances(merged, result.regionId, result.instances);
      repaired += 1;
    } else {
      failed += 1;
    }
  }
  return { snapshot: merged, repaired, failed, after: countInsertInstances(merged.mediaStructure) };
}
