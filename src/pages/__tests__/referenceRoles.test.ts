/**
 * V6.2 Reference Role 语义化回归：
 *  - 计划参考图角色 = 方案冻结（generationRole → 用户语言徽标；无 inline dropdown）；
 *  - 手动参考图通过 ⋯ 菜单设置用途（menuitemradio + 勾选）；
 *  - 语义标签映射：template=模板图 / person_reference=人物参考 /
 *    anime_character_reference=动漫角色参考 / generic_reference=附加参考；
 *  - 摘要行：Raw Prompt 的「图片N」↔ 徽标语义对照（describeReferenceImagesForUser）；
 *  - carry 链路：计划图片以 generationRole 进工作台（不带 mention role）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GenerationImageRole } from '../../types';
import { describeReferenceImagesForUser, SEMANTIC_REFERENCE_LABELS } from '../../features/vision/generationProvenance';

const STUDIO_SRC = readFileSync(new URL('../ImageStudio.tsx', import.meta.url), 'utf-8');
const CARRY_SRC = readFileSync(new URL('../../features/vision/carryApply.ts', import.meta.url), 'utf-8');

describe('语义参考标签（generationProvenance）', () => {
  it('mapsEveryGenerationRoleToUserLanguage：全角色枚举有中文语义（无 undefined 文案）', () => {
    const roles: GenerationImageRole[] = [
      'template', 'person_reference', 'anime_character_reference', 'background_reference',
      'style_reference', 'generic_reference',
    ];
    for (const role of roles) {
      expect(SEMANTIC_REFERENCE_LABELS[role]).toBeTruthy();
      expect(SEMANTIC_REFERENCE_LABELS[role]).not.toContain('undefined');
    }
    expect(SEMANTIC_REFERENCE_LABELS.template).toBe('模板图');
    expect(SEMANTIC_REFERENCE_LABELS.person_reference).toBe('人物参考');
    expect(SEMANTIC_REFERENCE_LABELS.anime_character_reference).toBe('动漫角色参考');
    expect(SEMANTIC_REFERENCE_LABELS.generic_reference).toBe('附加参考');
  });

  it('describesReferenceImagesForUser：图片1/2/3 → 语义对照行（@展示名）', () => {
    const lines = describeReferenceImagesForUser([
      { label: '原图', role: 'template' },
      { label: '新人物', role: 'person_reference' },
      { label: '角色卡', role: 'anime_character_reference' },
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('模板图：@原图');
    expect(lines[1]).toBe('人物参考：@新人物');
    expect(lines[2]).toBe('动漫角色参考：@角色卡');
    // 空展示名回落「未命名图片」（不出现 undefined）
    expect(describeReferenceImagesForUser([{ label: '', role: 'generic_reference' }])).toEqual(['附加参考：@未命名图片']);
  });
});

describe('ImageStudio 参考图 UI 接线（源码级守卫）', () => {
  it('planImagesShowSemanticBadgeWithoutDropdown：计划图片角色由方案冻结（改角色=回工作台）', () => {
    expect(STUDIO_SRC).toContain('planRoleBadge');
    expect(STUDIO_SRC).toContain('SEMANTIC_REFERENCE_LABELS');
    expect(STUDIO_SRC).toContain('改用途请回视觉工作台');
    // 计划分支不渲染 select / dropdown：role menu 只在手动分支
    const menuAt = STUDIO_SRC.indexOf('roleMenuIndex === index');
    const planBadgeAt = STUDIO_SRC.indexOf('function planRoleBadge');
    expect(menuAt).toBeGreaterThan(planBadgeAt);
  });

  it('manualImagesSetRoleThroughMenu：⋯ 菜单 menuitemradio + 勾选（含附加/人物/背景/风格四用途）', () => {
    expect(STUDIO_SRC).toContain('MANUAL_ROLE_OPTIONS');
    expect(STUDIO_SRC).toContain('menuitemradio');
    for (const label of ['附加参考', '人物参考', '背景参考', '风格与构图参考']) {
      expect(STUDIO_SRC).toContain(label);
    }
  });

  it('showsPlanRefsSummaryLine：摘要行呈现计划图片语义对照', () => {
    expect(STUDIO_SRC).toContain('data-testid="studio-plan-refs-summary"');
    expect(STUDIO_SRC).toContain('describeReferenceImagesForUser');
  });

  it('carryKeepsGenerationRoleNotMentionRole：计划图片带 GenerationImageRole + plan 来源进工作台', () => {
    // carryApply：StudioSourceImage.role = 生成合同角色（GenerationImageRole），origin 标记来源
    expect(CARRY_SRC).toContain('role?: GenerationImageRole');
    expect(CARRY_SRC).toContain("origin?: 'plan' | 'manual'");
    // ImageStudio carry 映射：剥离 mention role（@引用层），只带 generationRole / origin
    expect(STUDIO_SRC).toContain('generationRole: source.role');
    expect(STUDIO_SRC).toContain('origin: source.origin');
  });
});
