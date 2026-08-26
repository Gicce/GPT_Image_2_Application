/**
 * Canonical Anime Character 回归 Fixture（GUI 验收真实案例）：
 *
 * 模板 = 混合媒介：真人女性（黑色服装，蹲姿，photorealistic）
 *              + 动漫女性（站姿 / V 手势 / wink，anime_illustration，
 *                 模型把动漫层标注为 secondary_subject —— 历史缺陷触发条件）
 *              + 动漫面部 / 眼部 / 发型特写相框（anime detail inserts）
 *              + 霓虹边框贴纸（graphic decoration）
 * 修改 = 人物替换 strict（人物参考图）+ 服装 = 人物参考图；动作未修改（锁定）。
 *
 * 期望（§49）：
 *  - Canonical anime character：identity = Person Reference；hair 绑定人物参考；
 *    clothing = 人物参考服装动漫化；expression = 模板动漫 wink；
 *  - secondary subject 与全部 anime detail inserts 引用同一张角色卡；
 *  - detail insert 不再跟随真人主体、不再各自独立动漫化。
 */

import { describe, expect, it } from 'vitest';
import type { VisionAnalysis } from '../../../../types';
import { emptyWorkspace, fixtureAnalysis, fixtureProject } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import {
  CANONICAL_ANIME_CHARACTER_ID,
  bindDetailInsertsToCharacter,
  deriveAnimeCharacterSnapshot,
  resolveAnimeCharacter,
  referenceAppearanceFingerprint,
  validateAnimeCharacterConsistency,
} from '../animeCharacter';
import { mergeFinalGenerationPrompt } from '../promptCompiler';
import { buildEffectiveVisualPlan } from '../effectivePlan';
import { findAnimeSubjectRegion } from '../rendering';
import type { GenerationImageReference } from '../../../../types';
import type { VisualProject } from '../types';

function mixedCaseAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '真人蹲姿女性与wink动漫女性的混合媒介拼贴',
    subjects: [
      {
        label: '真人女性',
        count: 1,
        appearance: ['黑长直发'],
        pose: '蹲姿，双手抱膝',
        action: null,
        gesture: null,
        facial_expression: '平静自然表情',
        gaze: '看向镜头',
        position: { x: 0.05, y: 0.3, width: 0.45, height: 0.65 },
        orientation: '身体朝向右侧',
        clothing: ['黑色卫衣'],
        relations: [],
      },
      {
        label: '动漫女性',
        count: 1,
        appearance: ['银色双马尾'],
        pose: '站姿，重心在左腿',
        action: null,
        gesture: '右手比V字手势',
        facial_expression: '右眼闭合的wink眨眼',
        gaze: '看向镜头',
        position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 },
        orientation: '身体朝向左侧',
        clothing: ['水手服'],
        relations: [],
      },
    ],
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女性', semantic_role: 'secondary_subject', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫面部特写相框', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '面部特写相框插图' },
        { label: '动漫眼部特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '眼部特写插图' },
        { label: '动漫发型特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '发型特写插图' },
        { label: '霓虹边框贴纸', semantic_role: 'graphic_decoration', rendering_mode: 'graphic_design', identity_relation: 'none' },
      ],
    },
  } as unknown as VisionAnalysis;
}

function mixedCaseProject(): VisualProject {
  const analysis = mixedCaseAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '混合媒介wink案例',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: ['subject', 'clothing'],
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
  return { ...project, modification };
}

const IMAGE_REFS: GenerationImageReference[] = [
  { path: 'D:/imgs/mixed.png', label: '原图', role: 'template' },
  { path: 'D:/imgs/person.png', label: '人物参考', role: 'person_reference' },
];

function compileMixedCase(finalDescription = '将画面主体替换为人物参考图女性（黑色长卷发、米白露肩连衣裙）。') {
  const project = mixedCaseProject();
  return {
    project,
    compiled: mergeFinalGenerationPrompt({
      project,
      finalDescription,
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
    }),
  };
}

describe('§50 Canonical Anime Character（角色卡派生）', () => {
  it('animeCharacterSnapshotCreatedOnce：派生幂等且唯一（同一项目状态 → 同一张卡）', () => {
    const project = mixedCaseProject();
    const first = deriveAnimeCharacterSnapshot(project);
    const second = deriveAnimeCharacterSnapshot(project);
    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first!.id).toBe(CANONICAL_ANIME_CHARACTER_ID);
    expect(first!.revision).toBe(project.revision);
    expect(validateAnimeCharacterConsistency(project)).toEqual([]);
  });

  it('resolveAnimeCharacter：持久化卡 revision 过期 ⇒ 重新派生（绝不复用旧卡）', () => {
    const project = mixedCaseProject();
    const stale = { ...deriveAnimeCharacterSnapshot(project)!, revision: project.revision - 1 };
    const refreshed = resolveAnimeCharacter({ ...project, animeCharacter: stale });
    expect(refreshed!.revision).toBe(project.revision);
  });

  it('secondarySubjectUsesCanonicalAnimeCharacter：动漫主体身份行引用唯一角色卡（身份来自人物参考）', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('引用唯一 Canonical Anime Character');
    expect(compiled.prompt).toContain('动漫角色一致性合同');
    const character = deriveAnimeCharacterSnapshot(mixedCaseProject())!;
    expect(character.identitySource.kind).toBe('person_reference');
    expect(character.identitySource.label).toBe('人物参考');
    expect(character.expression.description).toContain('wink');
  });

  it('rootCauseRegression：动漫层标注为 secondary_subject 时插图跟随动漫主体（不再跟随真人）', () => {
    const project = mixedCaseProject();
    const animeRegion = findAnimeSubjectRegion(project.renderingContract!.regions);
    expect(animeRegion?.semanticRole).toBe('secondary_subject');
    const binding = bindDetailInsertsToCharacter(project)!;
    for (const insert of binding.rendering.regions.filter(r => r.semanticRole === 'detail_insert')) {
      expect(insert.mirrorTargetRole).toBe('secondary_subject');
    }
    expect(binding.bindings.length).toBe(3);
  });

  it('resolved appearance facts 进入角色卡与最终 Prompt', () => {
    const project = mixedCaseProject();
    const withFacts: VisualProject = {
      ...project,
      referenceAppearance: {
        fingerprint: referenceAppearanceFingerprint(undefined, 'D:/imgs/person.png'),
        hair: {
          baseColor: '深棕色', length: 'chest', texture: 'large_wave',
          parting: 'center', bangs: 'curtain', silhouetteDescription: '蓬松轮廓',
        },
        face: { shape: '鹅蛋脸', eyeShape: '杏眼', irisColor: '琥珀色', eyelashStyle: '纤长上扬' },
        accessories: ['银色耳钉'],
        clothing: ['米白连衣裙'],
        analyzedAt: '2026-08-25T00:00:00Z',
      },
    };
    const character = deriveAnimeCharacterSnapshot(withFacts)!;
    expect(character.hair.facts?.baseColor).toBe('深棕色');
    expect(character.hair.description).toContain('及胸');
    expect(character.face.description).toContain('鹅蛋脸');
    expect(character.eyes.description).toContain('琥珀色');
    const compiled = mergeFinalGenerationPrompt({
      project: withFacts,
      finalDescription: '仅替换人物身份。',
      imageReferences: IMAGE_REFS,
      personReplacementEnabled: true,
    });
    for (const fact of ['深棕色', '及胸', '大波浪卷', '鹅蛋脸', '杏眼', '琥珀色']) {
      expect(compiled.prompt).toContain(fact);
    }
  });

  it('外貌事实缺失时只保留来源约束，不发明颜色、脸型或瞳色', () => {
    const character = deriveAnimeCharacterSnapshot(mixedCaseProject())!;
    expect(character.hair.facts).toBeUndefined();
    expect(character.face.facts).toBeUndefined();
    expect(character.hair.description).toContain('与参考图一致');
    expect(character.hair.description).not.toMatch(/紫色|金色|蓝色/);
    expect(character.face.description).not.toMatch(/鹅蛋脸|瓜子脸|圆脸/);
  });
});

describe('§50 detail insert 绑定与禁止项', () => {
  it('animeDetailInsertUsesSecondaryCharacterRef：全部动漫插图 characterRef = canonical id', () => {
    const project = mixedCaseProject();
    const { bindings } = bindDetailInsertsToCharacter(project)!;
    expect(bindings.length).toBe(3);
    for (const binding of bindings) {
      expect(binding.characterRef).toBe(CANONICAL_ANIME_CHARACTER_ID);
    }
  });

  it('animeDetailInsertDoesNotCreateOwnHairDesign：插图同步合同锁定发型并显式禁止另画', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('同一发型与刘海');
    expect(compiled.prompt).toContain('禁止：另画发型、重新设计刘海、改变发色、重塑脸型或眼型、更换服装基底或配饰');
  });

  it('animeDetailInsertDoesNotRestoreTemplateCharacter：禁止恢复模板原动漫人物身份特征', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('禁止恢复画面模板原动漫人物的身份特征');
  });

  it('detailInsertPreservesAllowedCropVariation：允许变化仅裁切 / 放大 / 构图框取', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('允许变化：裁切范围、放大倍率、局部构图、框体角度');
    expect(compiled.prompt).toContain('本插图只是对同一角色的局部展示');
  });
});

describe('§50 服装传播与模板服装隔离', () => {
  it('personReferenceClothingPropagatesToAnimeCharacter：角色卡服装 = 人物参考服装动漫化', () => {
    const character = deriveAnimeCharacterSnapshot(mixedCaseProject())!;
    expect(character.clothing.source).toBe('person_reference');
    expect(character.clothing.canonicalDescription).toContain('人物参考图');
    expect(character.clothing.canonicalDescription).toContain('动漫媒介呈现');
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('服装基底：人物参考图');
  });

  it('templateClothingDoesNotLeakToAnimeDetails：模板动漫服装（水手服）不进最终 Prompt', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).not.toContain('水手服');
    expect(compiled.clothingConflicts).toEqual([]);
  });
});

describe('§52 最终 Prompt 合同', () => {
  it('finalPromptContainsAnimeCharacterConsistencyContract', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('【动漫角色一致性合同（强制执行）】');
    expect(compiled.prompt).toContain('唯一动漫角色设计实例');
    expect(compiled.prompt).toContain('禁止把人物身份参考图分别独立动漫化成多个不同版本');
    expect(compiled.sections).toContain('anime_character');
  });

  it('finalPromptContainsDetailInsertSyncContract', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.prompt).toContain('【细节插图同步合同（强制执行）】');
    expect(compiled.prompt).toContain('画面中共 3 个动漫局部插图（每个画框独立编号）');
    expect(compiled.sections).toContain('detail_insert_sync');
  });

  it('finalPromptDoesNotAllowIndependentAnimeRedesign：许可句被剥离且不产生阻断', () => {
    const { compiled } = compileMixedCase(
      '将画面主体替换为人物参考图女性。各相框插图可以使用不同发型与刘海以增加变化。整体保持模板构图。',
    );
    expect(compiled.prompt).not.toContain('可以使用不同发型');
    expect(compiled.animeGuard?.removedSentences.length).toBe(1);
    expect(compiled.animeConflicts).toEqual([]);
    expect(compiled.prompt).toContain('整体保持模板构图');
  });

  it('animeConflicts：合同段自身永不触发（禁止性表述不命中许可句检测）', () => {
    const { compiled } = compileMixedCase();
    expect(compiled.animeConflicts).toEqual([]);
  });
});

describe('§21 生成前一致性校验（阻断门禁）', () => {
  it('存在非规范角色卡 id（第二实例）⇒ 阻断 + 进入 blockingErrors', () => {
    const project = mixedCaseProject();
    const rogue = { ...deriveAnimeCharacterSnapshot(project)!, id: 'rogue-anime-character' };
    const tampered: VisualProject = { ...project, animeCharacter: rogue };
    expect(validateAnimeCharacterConsistency(tampered).length).toBeGreaterThan(0);
    const plan = buildEffectiveVisualPlan(tampered);
    expect(plan.blockingErrors.some(error => error.includes('非规范动漫角色卡'))).toBe(true);
  });

  it('绑定是修复型派生：篡改 mirrors 会被重建为完整锁定集（幂等自愈，不误阻断）', () => {
    const project = mixedCaseProject();
    const tampered: VisualProject = {
      ...project,
      renderingContract: {
        ...project.renderingContract!,
        regions: project.renderingContract!.regions.map(region =>
          region.semanticRole === 'detail_insert' && region.renderingMode === 'anime_illustration'
            ? { ...region, mirrors: ['identity', 'clothing'] }
            : region),
      },
    };
    const binding = bindDetailInsertsToCharacter(tampered)!;
    for (const insert of binding.rendering.regions.filter(r => r.semanticRole === 'detail_insert')) {
      expect(insert.mirrors).toContain('hair');
      expect(insert.mirrors).toContain('face');
      expect(insert.mirrors).toContain('eyes');
      expect(insert.characterRef).toBe(CANONICAL_ANIME_CHARACTER_ID);
    }
    expect(validateAnimeCharacterConsistency(tampered)).toEqual([]);
  });

  it('非混合媒介 / 无动漫层 ⇒ 校验恒空（不误伤）', () => {
    const plain = fixtureProject();
    expect(validateAnimeCharacterConsistency(plain)).toEqual([]);
    expect(deriveAnimeCharacterSnapshot(plain)).toBeNull();
  });
});

describe('§15 右栏方案行摘要', () => {
  it('Effective Plan 含「动漫角色 / 细节插图」两行（🔒 已统一角色卡 / 🔒 同步 @动漫主角色）', () => {
    const plan = buildEffectiveVisualPlan(mixedCaseProject());
    const animeRow = plan.rows.find(row => row.key === 'anime_character');
    const insertRow = plan.rows.find(row => row.key === 'detail_inserts');
    expect(animeRow?.value).toBe('🔒 已统一角色卡 · 标准');
    expect(insertRow?.value).toContain('🔒 同步 @动漫主角色');
    expect(insertRow?.value).toContain('3 个插图');
    expect(animeRow?.refs?.[0].fullLabel).toContain('人物参考');
  });
});
