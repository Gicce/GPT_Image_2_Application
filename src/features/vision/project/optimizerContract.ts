/**
 * Optimizer Hard Contract Lines（§14 优化器权限收缩）—— 从项目合同生成
 * 「不可变更事实」行，随优化请求进入【硬性合同】块。
 *
 * 优化器只负责「把已确定 Contract 表达成更好的生成语言」，无权裁决：
 *  - 人物是否替换 / 身份来源 / 强度 / 范围
 *  - 服装来源
 *  - 用户显式启用的修改维度
 *  - 区域是否应用
 *  - 媒介结构（混合媒介分层 / 同一人物规则）
 */

import { personContractHasImage, PERSON_STRENGTH_LABELS } from './personContract';
import { RENDERING_MODE_LABELS } from './rendering';
import type { VisualProject } from './types';

const DIMENSION_LABELS: Record<string, string> = {
  subject: '人物', pose: '动作', scene: '背景', camera: '镜头', style: '风格', clothing: '服装',
};

export function buildOptimizerHardContractLines(project: VisualProject): string[] {
  const lines: string[] = [];
  const person = project.modification.person;

  if (person?.enabled) {
    const hasImage = personContractHasImage(person);
    const label = person.source === 'description'
      ? (person.description?.trim() || '文字描述人物')
      : (person.label?.trim() || '人物参考图');
    lines.push(hasImage
      ? `人物替换：启用（强度=${PERSON_STRENGTH_LABELS[person.strength]}；身份主来源=@${label}；模板人物身份不保留）`
      : `人物替换：启用（按文字描述重建：${label}；强度=${PERSON_STRENGTH_LABELS[person.strength]}）`);
    if (person.replaceScope === 'custom_region') {
      lines.push(`人物替换范围：指定区域${person.targetRegionId ? `（区域合同生效）` : '（区域待选择）'}`);
    }
  }

  if (project.modification.activeDimensions.length > 0) {
    const labels = project.modification.activeDimensions
      .filter(key => key !== 'subject')
      .map(key => DIMENSION_LABELS[key] ?? key);
    if (labels.length > 0) {
      lines.push(`用户显式启用修改维度（必须真实修改并列入 changed_dimensions）：${labels.join('、')}`);
    }
  }

  const clothing = project.modification.clothingPolicy;
  if (person?.enabled || project.modification.activeDimensions.includes('clothing')) {
    if (clothing === 'preserve_original') {
      lines.push('服装来源：沿用画面模板服装（仅服装本身；绝不因此保留模板人物）');
    } else if (clothing === 'use_subject_reference') {
      lines.push('服装来源：人物参考图服装（身份与服装都来自人物参考）');
    } else {
      lines.push(`服装来源：自定义——${project.modification.customClothing.trim() || '（描述待填写）'}`);
    }
  }

  const enabledRegions = project.regions.filter(region => region.enabled);
  if (enabledRegions.length > 0) {
    lines.push(`区域替换：${enabledRegions.length} 个区域已启用（用途 / 替换对象 / 范围 / 约束以区域合同为准；区域外画面严格保持画面模板，你无权取消任何区域）`);
  }

  const rendering = project.renderingContract;
  if (rendering?.overallMode === 'mixed_media') {
    const layers = rendering.regions
      .map(region => `${region.label}=${RENDERING_MODE_LABELS[region.renderingMode]}${region.identityRelation === 'same_as_primary' ? '（与主体同一人物）' : ''}`)
      .join('；');
    lines.push(`媒介结构：混合媒介${rendering.preserveTemplateMediaStructure ? '（保持模板分层，禁止整图统一成单一媒介）' : ''}${layers ? `——${layers}` : ''}`);
  } else if (rendering?.overallMode === 'single_media' && rendering.singleMode && rendering.singleMode !== 'unknown') {
    lines.push(`媒介结构：单一媒介（${RENDERING_MODE_LABELS[rendering.singleMode]}），全图保持一致`);
  }

  return lines;
}
