/**
 * Skill Origin Guard（V6）—— 模板复用 Skill 派生项目的生成门禁。
 *
 * 背景：模板复用 Skill 的执行 = 从 Recipe 重建 VisualProject 并走视觉工作台
 * 同一条编译链。本守卫保证「编译产物确实覆盖了项目合同要求的全部关键块」——
 * 防止任何回归（或完整 Prompt 手动覆盖）把结构化合同方案降解成摘要 Prompt。
 *
 * 阻断式保护（用户明确要求）：project.originSkill 存在且编译产物缺关键合同块
 * ⇒ generateFromPlan 直接阻断，绝不静默降级生成。
 */

import { bindDetailInsertsToCharacter } from './animeCharacter';
import type { CompiledFinalPrompt } from './promptCompiler';
import { isPoseDimensionLocked, subjectsWithExpression } from './subjectExpression';
import type { VisualProject } from './types';

/** 合同块要求（block = Compiler section 名；label = 用户可读名）。 */
export interface SkillOriginCoverageRequirement {
  block: string;
  label: string;
  reason: string;
}

/** Compiler section 名 → 用户可读标签（与 SkillTraceDrawer BLOCK_LABELS 同口径）。 */
const SECTION_LABELS: Record<string, string> = {
  image_role: '图片角色合同',
  person_replacement: '人物替换合同',
  region: '区域编辑合同',
  rendering: '媒介结构合同',
  anime_character: '动漫角色一致性合同',
  detail_insert_sync: '细节插图同步合同',
  expression_lock: '表情锁定合同',
  clothing: '服装合同',
  dimension: '修改动作合同',
  template_preservation: '模板保留合同',
  final_description: '最终画面描述',
};

export function skillOriginSectionLabel(block: string): string {
  return SECTION_LABELS[block] ?? block;
}

/**
 * 项目合同 → 必须出现的合同块清单（纯函数；与 Compiler 装配条件一一对应）。
 * @param regionContractDisabled true = 区域技能已在技能中心停用（区域块按预期不编译）
 */
export function requiredContractBlocks(project: VisualProject, regionContractDisabled = false): SkillOriginCoverageRequirement[] {
  const required: SkillOriginCoverageRequirement[] = [];
  if (project.templateSnapshot) {
    required.push({ block: 'image_role', label: SECTION_LABELS.image_role, reason: '模板图与人物参考的职责分工是混合参考生成的根基' });
  }
  if (project.modification.person?.enabled) {
    required.push({ block: 'person_replacement', label: SECTION_LABELS.person_replacement, reason: '人物替换合同（身份唯一主来源 / 参考边界）' });
  }
  if (!regionContractDisabled && project.regions.some(region => region.enabled)) {
    required.push({ block: 'region', label: SECTION_LABELS.region, reason: '启用了区域替换' });
  }
  if (project.renderingContract) {
    required.push({ block: 'rendering', label: SECTION_LABELS.rendering, reason: '媒介结构合同（混合媒介分层 / 单一媒介一致性）' });
  }
  // 动漫主体层存在 ⇒ 角色卡 + 全部插图实例绑定必须编译
  if (bindDetailInsertsToCharacter(project)) {
    required.push({ block: 'anime_character', label: SECTION_LABELS.anime_character, reason: 'Canonical Anime Character（唯一角色设计实例）' });
    required.push({ block: 'detail_insert_sync', label: SECTION_LABELS.detail_insert_sync, reason: '局部插图必须同步同一动漫角色（不自建第二套脸）' });
  }
  if (isPoseDimensionLocked(project) && subjectsWithExpression(project).length > 0) {
    required.push({ block: 'expression_lock', label: SECTION_LABELS.expression_lock, reason: '模板锁定表情基线（wink 等禁止漂移）' });
  }
  if (project.modification.person?.enabled || project.modification.activeDimensions.includes('clothing')) {
    required.push({ block: 'clothing', label: SECTION_LABELS.clothing, reason: '服装来源合同（A/B/C 不变量）' });
  }
  if (project.templateSnapshot) {
    required.push({ block: 'template_preservation', label: SECTION_LABELS.template_preservation, reason: '锁定维度的模板基线（构图 / 镜头 / 风格 / 姿态）' });
  }
  return required;
}

/**
 * 校验编译产物覆盖度：非模板复用项目恒通过（普通项目不受影响）；
 * 模板复用项目缺任一必需块 ⇒ 返回阻断文案（generateFromPlan 直接拦截）。
 * 完整 Prompt 手动覆盖（fullPromptOverride）在模板复用项目上视为降级路径，一律阻断。
 */
export function validateSkillOriginContractCoverage(
  project: VisualProject,
  compiled: CompiledFinalPrompt,
  options: { regionContractDisabled?: boolean } = {},
): string[] {
  if (!project.originSkill) return [];
  if (compiled.sections.includes('full_prompt_override')) {
    return ['模板复用 Skill 项目禁用「完整 Prompt 手动覆盖」——手动覆盖会丢弃全部结构化合同层（图片角色 / 人物替换 / 媒介结构 / 动漫角色一致性 / 细节插图同步 / 表情锁定 / 模板保留）。请清空手动覆盖，恢复系统编译。'];
  }
  const present = new Set(compiled.sections);
  const missing = requiredContractBlocks(project, options.regionContractDisabled === true)
    .filter(requirement => !present.has(requirement.block));
  return missing.map(requirement =>
    `模板复用 Skill 的最终 Prompt 缺少关键合同块「${requirement.label}」（${requirement.reason}）。生成已阻断——请重新执行提示词优化或检查技能配置。`);
}
