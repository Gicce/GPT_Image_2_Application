import type { VisionAnalysis } from '../../../../types';
import { buildRecreationPlan, initialRecreationState } from '../../recreationPlan';
import type { VisualProject, VisualProjectWorkspace } from '../types';
import { createVisualProjectFromAnalysis } from '../project';
import { compileReversePrompt } from '../../reversePrompt';

export function fixtureAnalysis(overrides?: {
  style?: Partial<VisionAnalysis['style']>;
  mediaStructure?: unknown;
}): VisionAnalysis {
  const analysis = {
    summary: '一名男性篮球运动员在室内球馆上篮',
    subjects: [
      {
        label: '成年男性篮球运动员',
        appearance: ['短发', '红色球衣'],
        clothing: ['红色 23 号球衣'],
        pose: '腾空上篮',
        action: '单手扣篮',
        position: { x: 0.3, y: 0.2, width: 0.4, height: 0.7 },
        relations: [],
      },
    ],
    objects: [{ label: '篮球', attributes: ['橙色'] }],
    scene: {
      environment: '室内篮球馆',
      location: '比赛球场',
      time_of_day: '白天',
      weather: '',
      background: '观众席虚化',
      foreground: '',
    },
    composition: {
      subject_placement: '主体居中偏左',
      symmetry: '非对称',
      negative_space: '',
      crop: '全身',
      depth_layers: '',
    },
    camera: {
      shot_type: '中远景',
      perspective: '',
      angle: '低角度仰拍',
      depth_of_field: '浅景深',
      lens_characteristics: '',
    },
    lighting: {
      source: '顶部场馆灯',
      direction: '顶光',
      softness: '硬光',
      key_fill_rim: '',
      contrast: '高对比',
      time_of_day: '',
      exposure: '',
    },
    colors: { dominant_palette: ['红色', '橙色'], temperature: '暖色', saturation: '高', contrast: '' },
    style: {
      category: '运动摄影',
      medium: '照片',
      texture: '',
      rendering: '写实',
      photographic_characteristics: '',
      ...overrides?.style,
    },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  } as unknown as VisionAnalysis;
  if (overrides?.mediaStructure !== undefined) {
    (analysis as VisionAnalysis & { media_structure?: unknown }).media_structure = overrides.mediaStructure as never;
  }
  return analysis;
}

export function emptyWorkspace(analysis: VisionAnalysis | null = null): VisualProjectWorkspace {
  const plan = analysis ? buildRecreationPlan(analysis) : null;
  const reverse = analysis ? compileReversePrompt(analysis) : null;
  return {
    profileId: 'profile-1',
    modelId: 'glm-5v',
    mode: 'reverse_prompt',
    analysis,
    reverseResult: reverse,
    originalPromptDraft: reverse?.prompt ?? '',
    promptDraft: reverse?.prompt ?? '',
    negativeDraft: '',
    recreation: plan && reverse
      ? initialRecreationState(plan, reverse.prompt, reverse.negativePrompt)
      : null,
    genParams: { size: '1024x1024', quality: 'auto', count: 1 },
    generationMode: 'i2i',
    hfTarget: 0.9,
    hfMaxIterations: 2,
    report: null,
    iterations: [],
    visionTaskId: '',
    sessionId: '',
  };
}

export function fixtureProject(overrides?: {
  analysis?: VisionAnalysis;
  name?: string;
}): VisualProject {
  const analysis = overrides?.analysis ?? fixtureAnalysis();
  const workspace = emptyWorkspace(analysis);
  return createVisualProjectFromAnalysis({
    name: overrides?.name ?? '动漫照片风',
    analysis,
    plan: workspace.recreation!.plan,
    recreation: workspace.recreation!,
    sourceAsset: { path: 'D:/imgs/template.png', assetId: 'asset-1', source: 'gallery' },
    workspace,
  });
}
