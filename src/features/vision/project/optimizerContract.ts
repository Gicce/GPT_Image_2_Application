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
import { bindDetailInsertsToCharacter } from './animeCharacter';
import { extractTemplateClothingTokens } from './clothingGuard';
import { RENDERING_MODE_LABELS } from './rendering';
import { buildDimensionContracts } from './dimensionLock';
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
    // Reference Role Isolation（§25-§27）：换身份 ≠ 换姿势 / 换构图
    lines.push('人物参考边界：人物参考图仅提供人物身份特征（及按服装合同的服装）；'
      + '其姿势、动作、身体朝向、观看角度、镜头、构图与背景一律不得采用，这些维度一律以画面模板为准');
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

  // Dimension Lock §13/§14：动作未启用修改 ⇒ 逐主体姿态基线进入硬合同，
  // 优化器看得到每个主体的模板动作值，positive_prompt 无权为任何主体另写动作；
  // 表情是动作基线的独立锁定维度（wink 禁止稀释成半眯眼 / 微笑）。
  const poseLocked = buildDimensionContracts(project).find(contract => contract.key === 'pose')?.mode === 'locked';
  const subjectPoses = project.templateSnapshot?.subjectPoses ?? [];
  if (poseLocked && subjectPoses.length > 0) {
    const poseText = subjectPoses
      .map(pose => [
        `${pose.label}=`,
        pose.poseDescription,
        pose.gesture ? `手势=${pose.gesture}` : '',
        pose.facialExpression ? `表情=${pose.facialExpression}` : '',
        pose.gaze ? `视线=${pose.gaze}` : '',
        pose.bodyOrientation ? `（${pose.bodyOrientation}）` : '',
      ].filter(Boolean).join(''))
      .join('；');
    lines.push(`动作锁定（分主体，你无权改写）：${poseText}；`
      + 'positive_prompt 不得为任何主体编写新的动作、手势、肢体展开、表情、身体朝向或视线描述，'
      + '也不得从人物参考图带入任何姿势或表情（这些一律以画面模板为唯一事实来源）');
  }

  const clothing = project.modification.clothingPolicy;
  if (person?.enabled || project.modification.activeDimensions.includes('clothing')) {
    if (clothing === 'preserve_original') {
      lines.push('服装来源：沿用画面模板服装（仅服装本身；绝不因此保留模板人物）');
    } else if (clothing === 'use_subject_reference') {
      const tokens = extractTemplateClothingTokens(project);
      lines.push('服装来源：人物参考图服装（身份与服装都来自人物参考）');
      lines.push('服装反回灌（强制）：模板服装元素（含风格 / 媒介描述中出现的服装、配饰、装饰件'
        + (tokens.length > 0 ? `，如 ${tokens.slice(0, 6).join('、')}` : '')
        + '）一律不得写进 positive_prompt；动漫对应角色 / 次要主体的服装 = 人物参考图服装在该媒介下的转换呈现，'
        + '只做媒介转换、绝不恢复模板服装配饰');
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

  // Canonical Anime Character（动漫角色一致性）：人物替换 / 服装 / 媒介结构确认后
  // 才能派生角色卡——执行顺序由 Skill 依赖保证（§39），硬合同行随之进入优化请求。
  const animeBinding = bindDetailInsertsToCharacter(project);
  if (animeBinding) {
    const { character, bindings } = animeBinding;
    const identityLabel = character.identitySource.kind === 'person_reference'
      ? `人物参考图 @${character.identitySource.label ?? '人物参考图'}`
      : character.identitySource.kind === 'manual' ? '文字描述' : '模板原身份';
    lines.push(`动漫角色卡（唯一 Canonical Anime Character，你无权改写）：动漫主角色「${character.sourceSubjectLabel}」`
      + `由${identityLabel} + 模板动漫媒介规则派生；发型（含刘海 / 卷度 / 发色）、脸型、眼型与瞳色、配饰、服装基底全部唯一——`
      + '次要动漫主体与全部动漫局部插图必须复用同一角色设计；'
      + '禁止为任何动漫层重新设计发型 / 刘海 / 发色 / 脸型 / 眼型，禁止把人物参考图分别独立动漫化成多个版本，'
      + '禁止恢复模板原动漫人物的身份特征；「动漫化」只改变渲染媒介，不改变角色设计事实');
    if (bindings.length > 0) {
      lines.push(`细节插图同步（强制）：${bindings.length} 个动漫局部插图（${bindings.map(binding => binding.insertLabel).join('、')}）`
        + '全部引用动漫主角色的同一角色设计；插图只做裁切 / 放大 / 局部展示，'
        + '允许变化仅限取景与构图，禁止另画发型、改变瞳色、重塑脸型或更换服装基底');
    }
  }

  return lines;
}
