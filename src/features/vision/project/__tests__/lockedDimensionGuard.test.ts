import { describe, expect, it } from 'vitest';
import type { VisionAnalysis } from '../../../../types';
import { fixtureAnalysis, emptyWorkspace } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import {
  guardLockedDimensionsInDescription,
  compilePoseBaselineFallback,
} from '../lockedDimensionGuard';
import { mergeFinalGenerationPrompt } from '../promptCompiler';
import { buildOptimizerHardContractLines } from '../optimizerContract';
import type { VisualProject } from '../types';

/**
 * Dimension Lock §20 正文层回归（GUI 验收 P0）：
 * 模板 = 左下真人蹲姿 + 右侧动漫女孩站立比V 的混合媒介作品；
 * 人物参考 = 白色连衣裙女性；用户只勾选「修改人物 + 修改服装」，未勾选「修改动作」。
 */

function mixedMediaAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '左侧真人女性蹲姿与右侧动漫女孩站立的动漫AI照片风混合媒介作品',
    subjects: [
      {
        label: '真人女性',
        count: 1,
        appearance: ['长发'],
        pose: '蹲姿，侧头微笑注视镜头',
        action: null,
        position: { x: 0.05, y: 0.35, width: 0.45, height: 0.6 },
        orientation: '身体朝向右侧，正面微侧',
        clothing: ['白色连衣裙'],
        relations: [],
      },
      {
        label: '动漫女孩',
        count: 1,
        appearance: ['银发'],
        pose: '站姿，重心在左腿，单眼眨眼，比V字手势',
        action: null,
        position: { x: 0.55, y: 0.1, width: 0.4, height: 0.85 },
        orientation: '身体朝向左侧',
        clothing: ['水手服'],
        relations: [],
      },
    ],
    composition: { ...base.composition, subject_placement: '左侧真人位于左下，右侧动漫角色占主导，全身' },
    camera: { ...base.camera, shot_type: '平视中景', angle: '平视' },
    media_structure: {
      overall_mode: 'mixed_media',
      preserve_template_media_structure: true,
      regions: [
        { label: '真人层（真人女性）', semantic_role: 'primary_subject', rendering_mode: 'photorealistic', identity_relation: 'template_identity' },
        { label: '动漫女孩', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
      ],
    },
  } as unknown as VisionAnalysis;
}

function projectWith(dimensions: Array<'subject' | 'clothing' | 'pose' | 'camera'>): VisualProject {
  const analysis = mixedMediaAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: '动漫AI照片',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/mixed.png', assetId: 'asset-mixed', source: 'gallery' },
    workspace,
  });
  const modification = normalizeModificationContract({
    freeText: '',
    activeDimensions: dimensions,
    person: dimensions.includes('subject')
      ? {
        enabled: true,
        source: 'local',
        path: 'D:/imgs/person.png',
        label: '人物参考',
        strength: 'strict',
        replaceScope: 'whole_person',
        preserveTemplateIdentity: false,
        applyIdentityTo: 'primary_subject_only',
      }
      : null,
    clothingPolicy: dimensions.includes('clothing') ? 'use_subject_reference' : 'preserve_original',
    customClothing: '',
    replicationBoost: false,
    mentions: [],
    extraImageRefs: [],
  });
  return { ...project, modification };
}

const DRIFTED_DESCRIPTION = [
  '将画面主体替换为人物参考图中的年轻女性，她身穿白色连衣裙。',
  '她笔直站立并张开双臂，展现出舒展的姿态。',
  '右侧动漫女孩跳起来比出胜利手势。',
  '整体镜头改为高角度俯拍，服装与身份保留人物参考特征。',
].join('');

describe('guardLockedDimensionsInDescription（动作未勾选 ⇒ 正文守卫）', () => {
  it('D.9 只改人物+服装：真人仍蹲姿、动漫原姿态、镜头构图不变（漂移句被拦截）', () => {
    const project = projectWith(['subject', 'clothing']);
    const result = guardLockedDimensionsInDescription({
      description: DRIFTED_DESCRIPTION,
      project,
    });
    // 发明的新动作 / 朝向 / 镜头语言全部被拦截
    expect(result.removedSentences.length).toBe(3);
    expect(result.removedSentences.join('')).toContain('笔直站立');
    expect(result.removedSentences.join('')).toContain('跳起来');
    expect(result.removedSentences.join('')).toContain('俯拍');
    // 人物与服装修改描述保留（不属于锁定维度信号）
    expect(result.text).toContain('白色连衣裙');
    expect(result.text).not.toContain('笔直站立');
    expect(result.text).not.toContain('张开双臂');
    expect(result.text).not.toContain('跳起来');
    expect(result.text).not.toContain('俯拍');
    // V5 §57：描述只承载 Delta——不再向段末追加动作基线
    // （锁定基线唯一来源 = 【模板保留合同】，由编译端到端测试断言）
    expect(result.text).not.toContain('蹲姿，侧头微笑注视镜头');
    expect(result.guardedDimensions).toContain('pose');
    expect(result.guardedDimensions).toContain('camera');
  });

  it('基线含有的信号词不误伤：描述忠实沿用「蹲姿 / 比V字手势 / 平视」时保留', () => {
    const project = projectWith(['subject', 'clothing']);
    const faithful = '将主体替换为人物参考图女性，服装改为人物参考服装；真人女性保持蹲姿侧头微笑注视镜头，动漫女孩保持站姿比V字手势，镜头维持平视中景。';
    const result = guardLockedDimensionsInDescription({ description: faithful, project });
    expect(result.removedSentences).toEqual([]);
    expect(result.text).toContain('蹲姿');
    expect(result.text).toContain('比V字手势');
    expect(result.text).toContain('平视中景');
  });

  it('D.10 勾选「修改动作」后：动作漂移句放行（动作允许变化）', () => {
    const project = projectWith(['subject', 'clothing', 'pose']);
    const result = guardLockedDimensionsInDescription({
      description: DRIFTED_DESCRIPTION,
      project,
    });
    expect(result.removedSentences.join('')).not.toContain('笔直站立');
    expect(result.removedSentences.join('')).not.toContain('跳起来');
    expect(result.text).toContain('笔直站立');
    expect(result.text).toContain('跳起来');
    // 动作已解锁；镜头仍锁定（俯拍句仍被拦截）
    expect(result.text).not.toContain('俯拍');
    expect(result.guardedDimensions).toEqual(['camera']);
  });

  it('镜头维度勾选修改后：镜头语言放行（只锁动作）', () => {
    const project = projectWith(['subject', 'clothing', 'camera']);
    const result = guardLockedDimensionsInDescription({
      description: DRIFTED_DESCRIPTION,
      project,
    });
    expect(result.text).toContain('俯拍');
    expect(result.text).not.toContain('笔直站立');
    expect(result.guardedDimensions).toEqual(['pose']);
  });

  it('无模板快照 / 描述为空：原样返回（绝不误伤）', () => {
    const project = projectWith(['subject', 'clothing']);
    expect(guardLockedDimensionsInDescription({ description: '', project }).text).toBe('');
    const noSnapshot = { ...project, templateSnapshot: undefined } as VisualProject;
    const result = guardLockedDimensionsInDescription({ description: DRIFTED_DESCRIPTION, project: noSnapshot });
    expect(result.text).toBe(DRIFTED_DESCRIPTION);
    expect(result.removedSentences).toEqual([]);
  });

  it('compilePoseBaselineFallback：分主体输出动作 / 朝向基线', () => {
    const lines = compilePoseBaselineFallback(projectWith(['subject', 'clothing']));
    expect(lines).toContain('动作基线（模板唯一事实来源');
    expect(lines).toContain('朝向：身体朝向右侧，正面微侧');
    expect(lines).toContain('朝向：身体朝向左侧');
  });
});

describe('mergeFinalGenerationPrompt 集成（守卫进入最终 Prompt）', () => {
  it('D.9 端到端：描述段只含拦截后正文（Delta）；动作基线由模板保留合同承载（V5 §57）', () => {
    const project = projectWith(['subject', 'clothing']);
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: DRIFTED_DESCRIPTION,
      imageReferences: [],
      personReplacementEnabled: true,
    });
    expect(compiled.lockGuard).toBeDefined();
    expect(compiled.lockGuard!.removedSentences.length).toBe(3);
    // 最终画面描述段（最后一段）不含发明动作，也不拼接动作基线（只写 Delta）
    const descriptionSection = compiled.prompt.slice(compiled.prompt.indexOf('【最终画面描述】'));
    expect(descriptionSection).not.toContain('笔直站立');
    expect(descriptionSection).not.toContain('张开双臂');
    expect(descriptionSection).not.toContain('跳起来');
    expect(descriptionSection).not.toContain('俯拍');
    expect(descriptionSection).not.toContain('真人女性（主体）：蹲姿');
    expect(descriptionSection).not.toContain('动漫女孩（动漫对应角色）：站姿');
    // 动作基线在【模板保留合同】段（唯一事实来源；不再复制进描述段）
    expect(compiled.prompt).toContain('真人女性（主体）：蹲姿');
    expect(compiled.prompt).toContain('动漫女孩（动漫对应角色）：站姿');
    // Clothing Source Guard：服装来自人物参考（use_subject_reference）⇒ 模板服装
    // 「白色连衣裙」在最终画面描述中被逐句剥离（E5 只写修改项，模板服装不回灌）
    expect(descriptionSection).not.toContain('白色连衣裙');
    expect(compiled.clothingGuard?.removedSentences.join('')).toContain('白色连衣裙');
    // 模板保留合同仍承载构图 / 镜头 canonical 基线
    expect(compiled.prompt).toContain('- 构图：左侧真人位于左下，右侧动漫角色占主导，全身');
    expect(compiled.prompt).toContain('- 镜头：平视中景');
    // 段顺序：最终画面描述仍最后
    expect(compiled.sections[compiled.sections.length - 1]).toBe('final_description');
  });

  it('D.10 端到端：勾选修改动作后描述原样进入（lockGuard 不含 pose 拦截）', () => {
    const project = projectWith(['subject', 'clothing', 'pose']);
    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: DRIFTED_DESCRIPTION,
      imageReferences: [],
      personReplacementEnabled: true,
    });
    const descriptionSection = compiled.prompt.slice(compiled.prompt.indexOf('【最终画面描述】'));
    expect(descriptionSection).toContain('笔直站立');
    expect(descriptionSection).toContain('跳起来');
    expect(compiled.lockGuard!.guardedDimensions).not.toContain('pose');
  });
});

describe('buildOptimizerHardContractLines（优化器硬合同动作基线）', () => {
  it('动作锁定时：逐主体姿态进入硬合同，优化器无权改写', () => {
    const lines = buildOptimizerHardContractLines(projectWith(['subject', 'clothing']));
    const lockLine = lines.find(line => line.startsWith('动作锁定'));
    expect(lockLine).toBeDefined();
    expect(lockLine!).toContain('真人女性=蹲姿，侧头微笑注视镜头');
    expect(lockLine!).toContain('动漫女孩=站姿，重心在左腿');
    expect(lockLine!).toContain('不得为任何主体编写新的动作、手势、肢体展开、表情、身体朝向或视线描述');
  });

  it('动作勾选修改时：不输出动作锁定硬合同行', () => {
    const lines = buildOptimizerHardContractLines(projectWith(['subject', 'clothing', 'pose']));
    expect(lines.find(line => line.startsWith('动作锁定'))).toBeUndefined();
  });
});
