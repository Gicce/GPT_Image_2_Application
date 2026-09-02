/**
 * 漫画工作台流程状态测试（Phase 10/11）：
 *  - getComicStudioFlow：步骤完成 = 领域事实（不是「看过」）；currentStep = 第一个未完成；
 *  - deriveComicStage：事实 → 阶段标签梯子；skill_draft 钉住（确认技能必须是显式转换）；
 *    completed / failed 终态不回退；
 *  - comicStageLabel：未知阶段原样透出（不伪造）。
 */

import { describe, it, expect } from 'vitest';
import { comicStageLabel, deriveComicStage, getComicStudioFlow } from '../comicStudioFlow';
import { lockAnchor } from '../domain';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

function makeProject(options: {
  stage?: ComicProject['stage'];
  bindCharacter?: boolean;
  story?: boolean;
  panelCount?: number;
  completedPanels?: number;
  anchor?: boolean;
  dialoguesForStage?: boolean;
  /** V4.2.11 §F：高级「生成第一格后暂停确认」（默认 false） */
  pauseAfterFirstPanel?: boolean;
} = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线，低饱和暖色',
    consistencyRules: ['线条粗细一致'],
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
    ...(options.pauseAfterFirstPanel
      ? { referenceStrategy: { useAnchorAsStyle: true, characterRefs: 'required', pauseAfterFirstPanel: true } }
      : {}),
  });
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    status: 'locked',
    appearance: '奶油黄圆脸猫',
    immutableTraits: ['奶油黄短毛'],
    referenceImage: { path: '/refs/char-1.png', label: '汤圆参考图' },
  });
  const panelCount = options.panelCount ?? 2;
  const completed = options.completedPanels ?? 0;
  const panels = Array.from({ length: panelCount }, (_, index) => normalizeComicPanel({
    id: `panel-${index}`,
    order: index,
    scene: `场景${index}`,
    characterIds: ['char-1'],
    shotType: '全景',
    camera: '平视',
    composition: '居中',
    characterActions: [`动作${index}`],
    background: '工位',
    generationStatus: index < completed ? 'completed' : 'pending',
    imageAsset: index < completed ? { path: `/comic/p${index}.png`, imageId: `img-${index}`, taskId: `task-${index}` } : undefined,
  })!);
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: options.stage ?? 'skill_draft',
    skillSnapshot: skill,
    characterSnapshots: [character!],
    characterBindings: options.bindCharacter === false ? {} : { hero: 'char-1' },
    story: options.story === false ? undefined : {
      title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
      beats: ['a', 'b'], endingType: 'twist', panelCount,
    },
    panels,
    dialogues: [],
    consistency: options.anchor
      ? {
        anchor: { panelId: 'panel-0', path: '/comic/p0.png', imageId: 'img-0', taskId: 'task-0', lockedAt: '2026-08-30T02:00:00.000Z' },
        characterReferences: [],
        generationParams: { size: '1024x1024', quality: 'auto', format: 'png' },
      }
      : undefined,
  })!;
}

describe('getComicStudioFlow：步骤完成 = 领域事实', () => {
  it('skill_draft 阶段技能步骤未完成（确认必须是显式转换）', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'skill_draft' }));
    expect(flow.steps.find(step => step.id === 'skill')!.status).toBe('current');
    expect(flow.currentStep).toBe('skill');
  });

  it('技能确认后 → 技能步骤完成，角色未绑定则停在该步并给出阻塞项', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'character_confirmation', bindCharacter: false }));
    expect(flow.steps.find(step => step.id === 'skill')!.status).toBe('completed');
    const charactersStep = flow.steps.find(step => step.id === 'characters')!;
    expect(charactersStep.status).toBe('current');
    expect(flow.currentStep).toBe('characters');
    expect(charactersStep.blockers.length).toBeGreaterThan(0);
  });

  it('无分镜时 storyboard 未完成且 currentStep 停在分镜', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'story_ready', panelCount: 0 }));
    expect(flow.steps.find(step => step.id === 'storyboard')!.status).toBe('current');
    expect(flow.currentStep).toBe('storyboard');
  });

  it('V4.2.11 §D：默认无锚点门禁——首格已出图未审定也直接停在生成漫画画面步骤', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'generating_anchor', completedPanels: 1 }));
    const generateStep = flow.steps.find(step => step.id === 'generate')!;
    // P0-5：第一格不再要求用户审定；anchor 不是用户步骤
    expect(flow.currentStep).toBe('generate');
    expect(generateStep.status).toBe('current');
    expect(generateStep.blockers).toEqual([]);
    expect(flow.steps.map(step => step.id)).toEqual(['story', 'skill', 'characters', 'storyboard', 'generate', 'text']);
  });

  it('高级「生成第一格后暂停确认」开启时保留内部锚点门禁（blockers 可见）', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'generating_anchor', completedPanels: 1, pauseAfterFirstPanel: true }));
    const generateStep = flow.steps.find(step => step.id === 'generate')!;
    expect(flow.currentStep).toBe('generate');
    expect(generateStep.blockers.join('；')).toContain('第一格尚未确认');
  });

  it('全部成图 → imagesReady 且 currentStep=文字精修', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'editing', anchor: true, completedPanels: 2 }));
    expect(flow.imagesReady).toBe(true);
    expect(flow.currentStep).toBe('text');
    expect(flow.steps.find(step => step.id === 'generate')!.status).toBe('completed');
  });

  it('stale 分镜不计入事实（故事重排后旧图过期、新分镜未生成 → 未就绪）', () => {
    const project = makeProject({ stage: 'editing', anchor: true, completedPanels: 2 });
    const freshPanels = [0, 1].map(index => normalizeComicPanel({
      id: `panel-new-${index}`, order: index, scene: `重排后的新分镜${index}`, characterIds: ['char-1'],
      shotType: '全景', camera: '平视', composition: '居中', characterActions: ['a'], background: '会议室',
    })!);
    const regenerated = normalizeComicProject({
      ...project,
      panels: [...freshPanels, ...project.panels.map(panel => ({ ...panel, stale: true }))],
    })!;
    const flow = getComicStudioFlow(regenerated);
    expect(flow.imagesReady).toBe(false);
    expect(flow.steps.find(step => step.id === 'storyboard')!.status).toBe('completed');
  });
});

describe('deriveComicStage：事实 → 阶段梯子', () => {
  it('skill_draft 钉住：即使其余事实齐备也不自动跳走', () => {
    expect(deriveComicStage(makeProject({ stage: 'skill_draft', bindCharacter: false, story: false, panelCount: 0 }))).toBe('skill_draft');
    expect(deriveComicStage(makeProject({ stage: 'skill_draft' }))).toBe('skill_draft');
  });

  it('角色未就绪 → character_confirmation；角色就绪无故事 → story_ready', () => {
    expect(deriveComicStage(makeProject({ stage: 'character_confirmation', bindCharacter: false }))).toBe('character_confirmation');
    expect(deriveComicStage(makeProject({ stage: 'story_ready', story: false, panelCount: 0 }))).toBe('story_ready');
    expect(deriveComicStage(makeProject({ stage: 'story_ready', story: false, panelCount: 2 }))).toBe('story_ready');
  });

  it('V4.2.11 §F 默认（无暂停确认）：有分镜未全成图 → generating_panels；不再进入 anchor 中间阶段', () => {
    expect(deriveComicStage(makeProject({ stage: 'story_ready' }))).toBe('generating_panels');
    expect(deriveComicStage(makeProject({ stage: 'generating_anchor', completedPanels: 1 }))).toBe('generating_panels');
  });

  it('V4.2.11 §F 高级暂停确认开启：有分镜无锚点 → generating_anchor；首格已出图 → anchor_review（内部 enum 向后兼容）', () => {
    expect(deriveComicStage(makeProject({ stage: 'story_ready', pauseAfterFirstPanel: true }))).toBe('generating_anchor');
    expect(deriveComicStage(makeProject({ stage: 'generating_anchor', completedPanels: 1, pauseAfterFirstPanel: true }))).toBe('anchor_review');
  });

  it('锁定锚点后：未全成图 → generating_panels；全部成图 → editing', () => {
    expect(deriveComicStage(makeProject({ stage: 'anchor_review', anchor: true, completedPanels: 1 }))).toBe('generating_panels');
    expect(deriveComicStage(makeProject({ stage: 'generating_panels', anchor: true, completedPanels: 2 }))).toBe('editing');
  });

  it('终态不回退：completed / failed 原样保留', () => {
    expect(deriveComicStage(makeProject({ stage: 'completed', bindCharacter: false, panelCount: 0 }))).toBe('completed');
    expect(deriveComicStage(makeProject({ stage: 'failed', anchor: true, completedPanels: 2 }))).toBe('failed');
  });

  it('锁定锚点后故事重排（stale 化）仍保留 generating 事实阶段', () => {
    const project = makeProject({ stage: 'generating_panels', anchor: true, completedPanels: 2 });
    const restaged = normalizeComicProject({
      ...project,
      panels: [],
      story: undefined,
    })!;
    expect(deriveComicStage(restaged)).toBe('story_ready');
  });
});

describe('阶段推进闭环：审定 → lockAnchor → 系列门禁打开（高级暂停模式）', () => {
  it('开启暂停确认时：审定前 generate 带阻塞，lockAnchor 后清空', () => {
    const pending = makeProject({ stage: 'anchor_review', completedPanels: 1, pauseAfterFirstPanel: true });
    expect(getComicStudioFlow(pending).steps.find(step => step.id === 'generate')!.blockers.length).toBeGreaterThan(0);
    const locked = lockAnchor(pending, {
      panelId: 'panel-0',
      path: '/comic/p0.png',
      imageId: 'img-0',
      taskId: 'task-0',
      lockedAt: '2026-08-30T02:30:00.000Z',
    });
    expect(getComicStudioFlow(locked).steps.find(step => step.id === 'generate')!.blockers).toEqual([]);
    expect(deriveComicStage(locked)).toBe('generating_panels');
  });
});

describe('comicStageLabel', () => {
  it('已知阶段给中文标签（V4.2.11：内部锚点阶段不再暴露给用户语言），未知阶段原样透出', () => {
    expect(comicStageLabel('anchor_review')).toBe('生成漫画画面');
    expect(comicStageLabel('generating_anchor')).toBe('生成漫画画面');
    expect(comicStageLabel('editing')).toBe('对白与字幕');
    expect(comicStageLabel('mystery')).toBe('mystery');
  });
});
