/**
 * 场景表现 Prompt 编译测试（V4.2.12 §47~§63）——修「背景接近纯色/空白」：
 *  - 面板 Prompt 必含环境信息（场景与环境（强制）段），background 为空时兜底推导；
 *  - sceneRichness 三档（缺省 standard）；贴纸/立绘/纯背景画风豁免；
 *  - 同场景跨格连续性；时间进 Prompt；
 *  - 单格铁律不破：正向永不出现页面级形式词（四宫格/2×2/comic sheet），
 *    negative 保留多格拼图防线 + 背景防线（纯色/空白/背景新增主要角色）；
 *  - 无字底图铁律：对白文本永不进图片 Prompt（文字层独立）。
 */

import { describe, it, expect } from 'vitest';
import { compilePanelPrompt } from '../promptCompiler';
import { normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

interface SceneProjectOptions {
  background?: string;
  time?: string;
  visualStyle?: string;
  sceneRichness?: 'minimal' | 'standard' | 'rich';
  promptTemplate?: string;
  sharedBackground?: boolean;
}

function makeSceneProject(options: SceneProjectOptions = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '场景四格',
    visualStyle: options.visualStyle ?? '萌系简笔：圆润粗线，干净留白',
    promptTemplate: options.promptTemplate,
    layout: { panelCount: 4, arrangement: 'grid_4' },
    textStyle: { bubbleStyle: '', fontHint: '', dialogueMode: 'bubble' },
    generationRules: {
      negativeConstraints: ['乱码文字'],
      environmentTextAllowed: false,
      ...(options.sceneRichness ? { sceneRichness: options.sceneRichness } : {}),
    },
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
  });
  const panelSeed = [
    { id: 'panel-0', order: 0, scene: '开场：主角背着大书包出门', background: options.background ?? '' },
    { id: 'panel-1', order: 1, scene: '发展：课表排得满满当当', background: options.sharedBackground ? (options.background ?? '') : '另一些陈设' },
    { id: 'panel-2', order: 2, scene: '转折：趴在课桌上发愁', background: options.sharedBackground ? (options.background ?? '') : '第三处场景' },
    { id: 'panel-3', order: 3, scene: '结尾：镜前发现自己变圆', background: '家中穿衣镜前' },
  ];
  const panels = panelSeed.map(seed => normalizeComicPanel({
    ...seed,
    characterIds: [],
    shotType: '中景',
    camera: '平视',
    composition: '居中',
    characterActions: ['主角叹气'],
    ...(options.time ? { time: options.time } : {}),
  })!);
  return normalizeComicProject({
    id: 'p-scene',
    name: '场景第一期',
    stage: 'editing',
    skillSnapshot: skill,
    characterSnapshots: [],
    characterBindings: {},
    story: { title: 't', topic: 't', summary: 's', characterIds: [], beats: ['a'], endingType: 'twist', panelCount: 4 },
    panels,
    dialogues: [],
  })!;
}

function compile(project: ComicProject, panelId = 'panel-0') {
  const panel = project.panels.find(item => item.id === panelId)!;
  return compilePanelPrompt({ project, panel, mode: 'panel_regen' });
}

describe('§52/§55 场景段进 Prompt', () => {
  it('background 非空 → 「场景与环境（强制）」带具体环境 + standard 丰富度', () => {
    const project = makeSceneProject({ background: '简化的幼儿园教室，浅色黑板、两排小课桌、墙上贴着儿童画' });
    const { positive } = compile(project);
    expect(positive).toContain('场景与环境（强制）：简化的幼儿园教室');
    expect(positive).toContain('陈设简化但不空');
    expect(positive).toContain('画面核心事件');
  });

  it('background 为空（鸭梨山大实锤形状）→ 兜底推导明确场景，禁止留白', () => {
    const project = makeSceneProject({});
    const { positive } = compile(project);
    expect(positive).toContain('场景与环境（强制）：依据画面事件布置明确的故事场景背景');
    expect(positive).toContain('不是纯色或空白');
  });

  it('time（这一格发生在什么时候）编译进场景段', () => {
    const project = makeSceneProject({ background: '教室', time: '清晨' });
    expect(compile(project).positive).toContain('时间为清晨');
    const emptyBg = makeSceneProject({ time: '深夜' });
    expect(compile(emptyBg).positive).toContain('时间为深夜');
  });

  it('§60 同场景连续性：与其他格 background 相同 → 声明背景跨格连续', () => {
    const project = makeSceneProject({ background: '同一间教室，黑板与课桌位置固定', sharedBackground: true });
    expect(compile(project).positive).toContain('背景陈设与光线在格间保持连续一致');
    // 不同场景 → 无连续性声明
    const solo = makeSceneProject({ background: '唯一的教室' });
    expect(compile(solo).positive).not.toContain('格间保持连续一致');
  });
});

describe('§63 sceneRichness 三档', () => {
  it('缺省 = standard（简化但明确）', () => {
    expect(compile(makeSceneProject({ background: '教室' })).positive).toContain('陈设简化但不空');
  });

  it('minimal = 保持简洁，且不加背景防线', () => {
    const project = makeSceneProject({ background: '教室', sceneRichness: 'minimal' });
    const { positive, negative } = compile(project);
    expect(positive).toContain('背景保持简洁，只保留画面必要元素');
    expect(negative).not.toContain('纯色背景');
  });

  it('rich = 更丰富陈设但保持画风统一、不抢主体', () => {
    const { positive } = compile(makeSceneProject({ background: '教室', sceneRichness: 'rich' }));
    expect(positive).toContain('更丰富的环境陈设与细节');
    expect(positive).toContain('不抢主体');
  });
});

describe('§47 豁免：贴纸 / 立绘 / 纯背景画风不注入场景丰富度', () => {
  it.each(['可爱贴纸风', '角色立绘', '纯背景素材', '透明背景'])('visualStyle=%s → 无场景段、无背景防线', style => {
    const project = makeSceneProject({ visualStyle: style, background: '教室' });
    const { positive, negative } = compile(project);
    expect(positive).not.toContain('场景与环境（强制）');
    expect(negative).not.toContain('纯色背景');
  });
});

describe('§57/§59 防线', () => {
  it('正向永不出现页面级形式词（不在一格里画一页拼图）', () => {
    const project = makeSceneProject({ background: '教室' });
    const { positive } = compile(project);
    for (const word of ['四宫格', '九宫格', '2×2', 'comic sheet', 'four-panel layout', '宫格拼图']) {
      expect(positive).not.toContain(word);
    }
    // 单格强制行在场（这是「只画这一格」的指令，不是页面拼图指令）
    expect(positive).toContain('单格画面（强制）');
  });

  it('negative：多格防线 + 场景防线（standard/rich）同列', () => {
    const project = makeSceneProject({ background: '教室' });
    const { negative } = compile(project);
    for (const guard of ['多格拼图', '四宫格', 'comic sheet']) {
      expect(negative).toContain(guard);
    }
    for (const guard of ['纯色背景', '空白背景', '背景空无一物', '背景额外新增主要角色']) {
      expect(negative).toContain(guard);
    }
  });
});

describe('无字底图铁律（对白与图片层分离）', () => {
  it('图片 Prompt 不含对白内容 + 无字强制行在场', () => {
    const project = makeSceneProject({ background: '教室' });
    const { positive, negative } = compile(project);
    expect(positive).toContain('无字底图（强制）');
    // 「对白气泡」只出现在禁止行里（无字铁律的否定列举），不是排版指令
    expect(positive.match(/对白气泡/g)?.length).toBe(1);
    expect(negative).toContain('画面内文字');
    expect(negative).toContain('对白气泡');
  });
});

describe('自定义 promptTemplate 兼容（鸭梨山大快照形状）', () => {
  it('技能模板自定义时场景段仍独立追加（不依赖模板占位符）', () => {
    const project = makeSceneProject({
      background: '',
      promptTemplate: '【{{panel.scene}}】镜头 {{panel.shotType}}',
    });
    const { positive } = compile(project);
    expect(positive).toContain('【开场：主角背着大书包出门】');
    expect(positive).toContain('场景与环境（强制）：依据画面事件布置明确的故事场景背景');
    expect(positive).toContain('单格画面（强制）');
    expect(positive).not.toContain('四宫格');
  });
});
