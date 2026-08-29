/**
 * Skill Origin Guard（V6）—— 模板复用 Skill 派生项目的生成门禁回归：
 *  - 非模板复用项目恒通过（普通项目零影响）；
 *  - 完整 Prompt 手动覆盖 = 降级路径，一律阻断；
 *  - 缺必需合同块（媒介结构 / 动漫角色一致性 / 细节插图同步 / 表情锁定 /
 *    模板保留 / 图片角色 / 人物替换 / 服装）逐块给出阻断文案；
 *  - 区域技能停用 ⇒ 区域块按需不编译（真实效果，不误伤）。
 */

import { describe, expect, it } from 'vitest';
import { emptyWorkspace, fixtureAnalysis, fixtureProject } from './fixtures';
import { normalizeModificationContract } from '../project';
import type { CompiledFinalPrompt } from '../promptCompiler';
import {
  requiredContractBlocks,
  skillOriginSectionLabel,
  validateSkillOriginContractCoverage,
} from '../skillOriginGuard';
import type { VisualProject } from '../types';

const ORIGIN = {
  skillId: 'skill-1',
  skillName: '混合媒介复用',
  sourceProjectId: 'src-1',
  sourceRevision: 3,
  baselineFinalPrompt: '基线',
  baselineSections: ['image_role', 'rendering'],
  savedAt: '2026-08-28T00:00:00Z',
};

function compiledWith(sections: string[]): CompiledFinalPrompt {
  return {
    prompt: sections.join('\n\n'),
    negativePrompt: '',
    sections,
    sectionBlocks: sections.map(name => ({ name, text: name })),
    clothingConflicts: [],
    animeConflicts: [],
  };
}

/** 混合媒介 + 人物替换 + 动漫插图（触发 anime_character / detail_insert_sync 必需）。 */
function mixedOriginProject(): VisualProject {
  const analysis = fixtureAnalysis({
    mediaStructure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女性', semantic_role: 'secondary_subject', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: 'wink 站姿' },
        { label: '动漫面部特写相框', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '面部特写插图' },
      ],
    },
  });
  const workspace = emptyWorkspace(analysis);
  workspace.promptDraft = '按模板生成';
  const project = fixtureProject({ analysis, name: '混合媒介' });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject'],
    person: {
      enabled: true,
      source: 'local',
      path: 'D:/imgs/person.png',
      label: '人物参考',
      strength: 'strict',
      replaceScope: 'whole_person',
      preserveTemplateIdentity: false,
      applyIdentityTo: 'all_corresponding_subjects',
    },
    clothingPolicy: 'use_subject_reference',
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, workspace, modification, originSkill: ORIGIN };
}

describe('Skill Origin Guard：作用域', () => {
  it('非模板复用项目恒通过（即使编译产物为空）', () => {
    const project = fixtureProject();
    expect(project.originSkill).toBeUndefined();
    expect(validateSkillOriginContractCoverage(project, compiledWith([]))).toEqual([]);
  });

  it('section 标签映射：Compiler section 名 → 用户可读名', () => {
    expect(skillOriginSectionLabel('image_role')).toBe('图片角色合同');
    expect(skillOriginSectionLabel('detail_insert_sync')).toBe('细节插图同步合同');
    expect(skillOriginSectionLabel('custom_block')).toBe('custom_block');
  });
});

describe('Skill Origin Guard：阻断规则', () => {
  it('完整 Prompt 手动覆盖（full_prompt_override）= 丢弃全部合同层 ⇒ 阻断', () => {
    const errors = validateSkillOriginContractCoverage(
      mixedOriginProject(),
      compiledWith(['full_prompt_override']),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('手动覆盖');
  });

  it('缺媒介结构 / 动漫角色一致性 / 细节插图同步 / 表情锁定 / 模板保留 ⇒ 逐块阻断', () => {
    const project = mixedOriginProject();
    const compiled = compiledWith(['image_role', 'person_replacement', 'clothing']);
    const errors = validateSkillOriginContractCoverage(project, compiled);
    const blocks = requiredContractBlocks(project).map(requirement => requirement.block);
    expect(blocks).toContain('rendering');
    expect(blocks).toContain('anime_character');
    expect(blocks).toContain('detail_insert_sync');
    expect(errors.length).toBe(blocks.filter(block => !compiled.sections.includes(block)).length);
    expect(errors.join('\n')).toContain('媒介结构合同');
    expect(errors.join('\n')).toContain('动漫角色一致性合同');
    expect(errors.join('\n')).toContain('细节插图同步合同');
    expect(errors.join('\n')).toContain('模板保留合同');
  });

  it('全部必需块齐全 ⇒ 零阻断', () => {
    const project = mixedOriginProject();
    const required = requiredContractBlocks(project).map(requirement => requirement.block);
    expect(validateSkillOriginContractCoverage(project, compiledWith([...required]))).toEqual([]);
  });

  it('区域技能停用 ⇒ 区域块按需不编译（不误伤、不误导用户开技能）', () => {
    const project: VisualProject = {
      ...mixedOriginProject(),
      regions: [{
        id: 'region-1', name: '贴纸区', enabled: true, createdAt: '2026-08-28T00:00:00Z',
        replaceType: 'object', constraintStrength: 'strict',
        shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.3, h: 0.2 },
      }],
    };
    const required = requiredContractBlocks(project).map(requirement => requirement.block);
    expect(required).toContain('region');
    const withoutRegion = compiledWith(required.filter(block => block !== 'region'));
    // 未声明停用 ⇒ 缺区域块阻断
    expect(validateSkillOriginContractCoverage(project, withoutRegion).join('\n')).toContain('区域编辑合同');
    // 声明停用（技能中心真实状态）⇒ 通过
    expect(validateSkillOriginContractCoverage(project, withoutRegion, { regionContractDisabled: true })).toEqual([]);
  });
});
