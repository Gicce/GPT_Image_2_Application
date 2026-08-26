import { describe, expect, it } from 'vitest';
import type { VisionAnalysis } from '../../../../types';
import { fixtureAnalysis, emptyWorkspace } from './fixtures';
import { createVisualProjectFromAnalysis, normalizeModificationContract } from '../project';
import {
  classifyFacialExpression,
  isPoseDimensionLocked,
  subjectsWithExpression,
} from '../subjectExpression';
import { compileFacialExpressionContract, mergeFinalGenerationPrompt } from '../promptCompiler';
import { guardLockedDimensionsInDescription } from '../lockedDimensionGuard';
import { deriveRenderingContract } from '../rendering';
import { normalizeSubjectPoses } from '../template';
import { buildOptimizerHardContractLines } from '../optimizerContract';
import type { VisualProject } from '../types';

/**
 * 表情分离锁定回归（动漫主体 wink 漂移专项）：
 * 模板 = 左下真人蹲姿 + 右侧动漫女孩 wink（右眼闭合）比V 的混合媒介作品；
 * 局部插图 = 动漫女孩眼部特写；用户只改人物身份 + 服装，未勾选「修改动作」。
 */

function winkAnalysis(): VisionAnalysis {
  const base = fixtureAnalysis();
  return {
    ...base,
    summary: '左侧真人女性与右侧wink动漫女孩的混合媒介拼贴作品',
    subjects: [
      {
        label: '真人女性',
        count: 1,
        appearance: ['长发'],
        pose: '蹲姿，侧头注视镜头',
        action: null,
        gesture: null,
        facial_expression: '平静自然表情',
        gaze: '看向镜头',
        position: { x: 0.05, y: 0.35, width: 0.45, height: 0.6 },
        orientation: '身体朝向右侧，正面微侧',
        clothing: ['白色连衣裙'],
        relations: [],
      },
      {
        label: '动漫女孩',
        count: 1,
        appearance: ['银发'],
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
        { label: '动漫女孩', semantic_role: 'anime_counterpart', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary' },
        { label: '动漫女孩眼部特写', semantic_role: 'detail_insert', rendering_mode: 'anime_illustration', identity_relation: 'same_as_primary', description: '右眼闭合wink的眼部局部放大插图' },
        { label: '脚部特写贴纸', semantic_role: 'detail_insert', rendering_mode: 'graphic_design', identity_relation: 'same_as_primary', description: '小腿与鞋子的局部贴纸' },
      ],
    },
  } as unknown as VisionAnalysis;
}

function winkProject(dimensions: Array<'subject' | 'clothing' | 'pose'>): VisualProject {
  const analysis = winkAnalysis();
  const workspace = emptyWorkspace(analysis);
  const project = createVisualProjectFromAnalysis({
    name: 'wink动漫混合媒介',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/wink.png', assetId: 'asset-wink', source: 'gallery' },
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

describe('表情分类（classifyFacialExpression）', () => {
  it('wink 家族：右眼闭合 → wink_right；左眼闭合 → wink_left；未指明眼别 → one_eye_closed', () => {
    expect(classifyFacialExpression('右眼闭合的wink眨眼')).toBe('wink_right');
    expect(classifyFacialExpression('左眼闭合成wink，右眼睁开')).toBe('wink_left');
    expect(classifyFacialExpression('单眼眨眼wink')).toBe('one_eye_closed');
    expect(classifyFacialExpression('一只眼睛闭着的眨眼')).toBe('one_eye_closed');
  });

  it('非 wink 表情与空值：微笑 / 中性 / null 不触发 wink 强化', () => {
    expect(classifyFacialExpression('嘴角上扬微笑')).toBe('smile');
    expect(classifyFacialExpression('平静无表情')).toBe('neutral');
    expect(classifyFacialExpression('')).toBeNull();
    expect(classifyFacialExpression(null)).toBeNull();
  });
});

describe('A1 动作未勾选 ⇒ 动漫主体 wink 整套锁定（测试组 A1）', () => {
  it('模板快照：gesture / facialExpression / gaze 与姿态分列冻结', () => {
    const project = winkProject(['subject', 'clothing']);
    const poses = project.templateSnapshot!.subjectPoses!;
    const anime = poses.find(pose => pose.label === '动漫女孩')!;
    expect(anime.subjectRole).toBe('anime_counterpart');
    expect(anime.poseDescription).toBe('站姿，重心在左腿');
    expect(anime.gesture).toBe('右手比V字手势');
    expect(anime.facialExpression).toBe('右眼闭合的wink眨眼');
    expect(anime.gaze).toBe('看向镜头');
    expect(anime.bodyOrientation).toBe('身体朝向左侧');
  });

  it('不变量 1/2：未勾选修改动作 ⇒ pose/gesture/表情/视线全部锁定；wink 分类非空且进入表情锁定合同', () => {
    const project = winkProject(['subject', 'clothing']);
    expect(isPoseDimensionLocked(project)).toBe(true);
    const subjects = subjectsWithExpression(project);
    expect(subjects.length).toBe(2);
    expect(subjects[0].label).toBe('动漫女孩'); // wink 主体排前
    expect(classifyFacialExpression(subjects[0].facialExpression)).toBe('wink_right');

    const contract = compileFacialExpressionContract(project);
    expect(contract).toContain('【表情锁定合同（强制执行）】');
    expect(contract).toContain('动漫女孩（动漫对应角色）');
    expect(contract).toContain('右眼完全闭合、左眼保持睁开展现清晰可辨的 wink 单眼眨眼');
    expect(contract).toContain('不是眯眼、不是半闭半睁');
    expect(contract).toContain('表情锁定优先级高于风格与氛围描述');
  });

  it('最终 Prompt：expression_lock 层进入装配；最终画面描述仍在最后；模板保留合同分列表情', () => {
    const compiled = mergeFinalGenerationPrompt({
      project: winkProject(['subject', 'clothing']),
      finalDescription: '将画面主体替换为人物参考图女性，服装改为人物参考服装。',
      imageReferences: [],
      personReplacementEnabled: true,
    });
    expect(compiled.sections).toContain('expression_lock');
    expect(compiled.sections[compiled.sections.length - 1]).toBe('final_description');
    expect(compiled.prompt).toContain('【表情锁定合同（强制执行）】');
    expect(compiled.prompt).toContain('不是眯眼、不是半闭半睁');
    // 模板保留合同：动作分主体行分列手势 / 表情 / 视线 / 朝向
    expect(compiled.prompt).toContain('手势：右手比V字手势');
    expect(compiled.prompt).toContain('表情：右眼闭合的wink眨眼');
    expect(compiled.prompt).toContain('视线：看向镜头');
  });

  it('C1 正文守卫：把 wink 重写成「微笑双眼睁开」的句子被拦截；忠实 wink 描述保留', () => {
    const project = winkProject(['subject', 'clothing']);
    const drifted = guardLockedDimensionsInDescription({
      description: '右侧动漫女孩面带微笑，双眼睁大自信地望向镜头，张开双臂迎接观众。',
      project,
    });
    expect(drifted.removedSentences.length).toBe(1);
    expect(drifted.removedSentences[0]).toContain('微笑');

    const faithful = guardLockedDimensionsInDescription({
      description: '右侧动漫女孩保持右眼闭合的wink眨眼与右手比V字手势。',
      project,
    });
    expect(faithful.removedSentences).toEqual([]);
    expect(faithful.text).toContain('右眼闭合的wink眨眼');
  });

  it('优化器硬合同：表情进入动作锁定基线（无权改写清单含表情）', () => {
    const lines = buildOptimizerHardContractLines(winkProject(['subject', 'clothing']));
    const lockLine = lines.find(line => line.startsWith('动作锁定'))!;
    expect(lockLine).toContain('表情=右眼闭合的wink眨眼');
    expect(lockLine).toContain('手势=右手比V字手势');
    expect(lockLine).toContain('不得为任何主体编写新的动作、手势、肢体展开、表情、身体朝向或视线描述');
  });
});

describe('A2 局部插图表情一致性（测试组 A2）', () => {
  it('deriveRenderingContract：眼部特写继承 facial_expression；非面部特写不继承', () => {
    const rendering = deriveRenderingContract(winkAnalysis());
    const eyeInsert = rendering.regions.find(region => region.label === '动漫女孩眼部特写')!;
    expect(eyeInsert.mirrors).toContain('facial_expression');
    expect(eyeInsert.mirrors).toContain('identity');
    expect(eyeInsert.mirrorTargetRole).toBe('secondary_subject');

    const footInsert = rendering.regions.find(region => region.label === '脚部特写贴纸')!;
    expect(footInsert.mirrors).not.toContain('facial_expression');
    expect(footInsert.mirrors).toContain('identity');
  });

  it('最终 Prompt：眼部特写插图继承同一 wink 表情语义（不会丢失）', () => {
    const compiled = mergeFinalGenerationPrompt({
      project: winkProject(['subject', 'clothing']),
      finalDescription: '将画面主体替换为人物参考图女性。',
      imageReferences: [],
      personReplacementEnabled: true,
    });
    // 动漫插图走独立的【细节插图同步合同】（引用 Canonical Anime Character）
    expect(compiled.prompt).toContain('【细节插图同步合同（强制执行）】');
    const eyeLine = compiled.prompt.split('\n').find(line =>
      line.startsWith('- 插图 #') && line.includes('动漫女孩眼部特写'))!;
    expect(eyeLine).toContain('右眼闭合的wink眨眼');
    expect(eyeLine).toContain('same character design');
    // 非动漫插图（脚部贴纸，graphic）：进入同步合同「非动漫局部插图」小节，
    // 镜像画面主体（绝不绑动漫角色卡、不携带动漫表情基线）
    const footLine = compiled.prompt.split('\n').find(line =>
      line.startsWith('- 插图 #') && line.includes('脚部特写贴纸'))!;
    expect(footLine).not.toContain('右眼闭合');
    expect(footLine).toContain('同一角色');
    expect(footLine).not.toContain('动漫主角色');
  });
});

describe('A3 显式解锁（测试组 A3）', () => {
  it('勾选「修改动作」：表情锁定合同缺省、正文表情句放行、基线不回退（显式行为非隐式漂移）', () => {
    const project = winkProject(['subject', 'clothing', 'pose']);
    expect(isPoseDimensionLocked(project)).toBe(false);
    expect(compileFacialExpressionContract(project)).toBe('');

    const result = guardLockedDimensionsInDescription({
      description: '右侧动漫女孩面带微笑，双眼睁大望向镜头。',
      project,
    });
    expect(result.removedSentences).toEqual([]);
    expect(result.guardedDimensions).toEqual(['camera']);

    const compiled = mergeFinalGenerationPrompt({
      project,
      finalDescription: '右侧动漫女孩面带微笑，双眼睁大望向镜头。',
      imageReferences: [],
      personReplacementEnabled: true,
    });
    expect(compiled.sections).not.toContain('expression_lock');
  });
});

describe('持久化恢复（normalizeSubjectPoses）', () => {
  it('gesture / facialExpression / gaze 恢复合法化；无效条目丢弃', () => {
    const restored = normalizeSubjectPoses([
      {
        id: 'pose-2', label: '动漫女孩', subjectRole: 'anime_counterpart',
        poseDescription: '站姿', gesture: '右手比V', facialExpression: '右眼wink', gaze: '看向镜头',
        bodyOrientation: '朝向左侧', source: 'template_analysis',
      },
      { label: '', poseDescription: '无效条目' },
    ] as never)!;
    expect(restored!.length).toBe(1);
    expect(restored![0].gesture).toBe('右手比V');
    expect(restored![0].facialExpression).toBe('右眼wink');
    expect(restored![0].gaze).toBe('看向镜头');
    expect(restored![0].bodyOrientation).toBe('朝向左侧');
  });
});
