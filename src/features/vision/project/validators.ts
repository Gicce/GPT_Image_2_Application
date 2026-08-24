/**
 * Domain Validators（§37 / §38）—— 生成前的语义硬校验。
 *
 * 只有真正语义错误才阻断生成（strict 无参考图 / 自定义服装空描述 /
 * 指定区域不存在 / 模板缺失）；折叠 / Tab / Viewer 等视图状态一律不参与。
 */

import { clothingReadinessError } from '../modificationIntent';
import { toModificationDraft } from './project';
import { validatePersonReplacement } from './personContract';
import { validateRegionContract } from './region';
import { validateRenderingContract } from './rendering';
import type { VisualProject } from './types';

/** 项目级校验（加载 / 持久化边界）。 */
export function validateVisualProject(project: VisualProject | null): string[] {
  if (!project) return ['项目不存在。'];
  const errors: string[] = [];
  if (!project.id) errors.push('项目缺少 id。');
  if (!project.sourceAsset?.path?.trim() && project.status !== 'draft') {
    errors.push('项目缺少识别图（模板源图）。');
  }
  if (project.projectVersion !== 1) {
    errors.push(`项目版本不支持：${String(project.projectVersion)}。`);
  }
  errors.push(...validatePersonReplacement(project.modification.person));
  errors.push(...validateRegionContract(project.regions, project.references));
  errors.push(...validateRenderingContract(project.renderingContract));
  return errors;
}

/**
 * 生成前合同校验（§38 硬门禁）：只有语义错误阻断；
 * 模板缺失 = 无 templateSnapshot 或源图路径为空（无法构建图生图模板角色）。
 */
export function validateGenerationContract(project: VisualProject | null): string[] {
  if (!project) return ['项目不存在。'];
  const errors: string[] = [];
  if (!project.templateSnapshot || !project.sourceAsset.path?.trim()) {
    errors.push('缺少画面模板（识别图未就绪）。');
  }
  const person = project.modification.person;
  if (person?.enabled) {
    errors.push(...validatePersonReplacement(person));
  }
  const clothingError = clothingReadinessError(toModificationDraft(project.modification));
  if (clothingError) errors.push(clothingError);
  if (person?.replaceScope === 'custom_region') {
    const region = project.regions.find(r => r.id === person.targetRegionId);
    if (!region) {
      errors.push('替换范围为「指定区域」时必须先在区域编辑器中创建并选择区域。');
    } else if (!region.enabled) {
      errors.push(`区域「${region.name}」已停用，无法作为人物替换目标。`);
    }
  }
  for (const regionError of validateRegionContract(project.regions, project.references)) {
    errors.push(regionError);
  }
  return errors;
}
