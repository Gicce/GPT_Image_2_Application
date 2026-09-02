/**
 * V4.2.13 AI 对白导演（Planner §31~§37 / Vision §45~§52）纯函数焦点测试：
 *  - Planner：proposal → 草稿（placementSource='planner' + 安全泳道坐标）；
 *    applyDialogueDrafts 默认 fill（已有可见对白的格整格跳过，AI 永不覆写用户内容），
 *    overwrite=true 才整格替换且 summary 如实记录；
 *  - Vision 本地确定性求解器：无主体 → 安全默认泳道（basis='default'，阅读顺序
 *    逐锚点不叠放）；有主体 → 选重叠代价最小锚点（避让）；条形样式固定泳道；
 *    尾巴只指向最近主体且仅带尾样式；输出全部过 clamp（与手工拖拽同一道闸）；
 *  - applyVisionPlacement：只改几何 / placementSource='vision'，文字与样式绝不改；
 *    applySize / applyTail 可关；无命中 → 原引用返回；
 *  - proposeComicDialoguePlacement：成图格真实分析（注入 analyze 编排测试，不冒充
 *    真实视觉）；失败 / 无图回落默认布局不中断整批；无对白格跳过。
 */

import { describe, expect, it } from 'vitest';
import {
  applyDialogueDrafts,
  applyVisionPlacement,
  dialogueDraftFromProposal,
  proposeComicDialoguePlacement,
  solveVisionPlacement,
  type VisionAnalyzeFn,
} from '../dialogueDirector';
import { normalizeComicDialogue, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicDialogue, ComicPanel, ComicProject } from '../types';
import type { VisionAnalyzeResult } from '../../../types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makePanel(overrides: Partial<ComicPanel> = {}): ComicPanel {
  return normalizeComicPanel({
    id: 'p-1', order: 0, scene: '开场', ...overrides,
  })!;
}

function makeDialogue(overrides: Partial<ComicDialogue> = {}): ComicDialogue {
  return normalizeComicDialogue({
    id: 'dlg-1', panelId: 'p-1', text: '妈妈，功课好多呀……', ...overrides,
  })!;
}

function makeProject(overrides: {
  panels?: ComicPanel[]; dialogues?: ComicDialogue[];
} = {}): ComicProject {
  return normalizeComicProject({
    id: 'project-1',
    name: '第一期',
    stage: 'editing',
    skillSnapshot: normalizeComicSkill({ id: 'skill-1', name: '四格', comicForm: '四格漫画', version: 1 })!,
    panels: overrides.panels ?? [makePanel(), makePanel({ id: 'p-2', order: 1, scene: '冲突' })],
    dialogues: overrides.dialogues ?? [],
  })!;
}

// ---------------------------------------------------------------------------
// Planner：proposal → 草稿 → apply
// ---------------------------------------------------------------------------

describe('Planner：dialogueDraftFromProposal + applyDialogueDrafts', () => {
  it('proposal → 草稿：文字/说话人/类型/样式建议 + placementSource=planner + 安全泳道坐标', () => {
    const project = makeProject();
    const draft = dialogueDraftFromProposal(project, project.panels[0]!, {
      order: 0, speakerId: 'char-1', type: 'speech', text: '今天也要加油！', suggestedStyle: 'cloud',
    }, 0);
    expect(draft.panelId).toBe('p-1');
    expect(draft.text).toBe('今天也要加油！');
    expect(draft.speakerId).toBe('char-1');
    expect(draft.type).toBe('speech');
    expect(draft.bubbleStyle).toBe('cloud');
    expect(draft.placementSource).toBe('planner');
    // 泳道坐标（seedIndex 0 → x=0.32, y=0.22；中心点钳制范围内）
    expect(draft.position.x).toBeGreaterThan(0.05);
    expect(draft.position.x).toBeLessThan(0.95);
    expect(draft.position.y).toBeGreaterThan(0.05);
    expect(draft.position.y).toBeLessThan(0.95);
  });

  it('fill 铁律：已有可见对白的格整格跳过（AI 不覆写用户内容）；空白格照常补', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ panelId: 'p-1', text: '人工已写' }), // p-1 有内容
    ] });
    const drafts = [
      dialogueDraftFromProposal(project, project.panels[0]!, { order: 0, speakerId: 'narrator', type: 'caption', text: 'AI 建议 1', suggestedStyle: 'box-light' }, 0),
      dialogueDraftFromProposal(project, project.panels[1]!, { order: 0, speakerId: 'narrator', type: 'caption', text: 'AI 建议 2', suggestedStyle: 'box-light' }, 0),
    ];
    const { project: next, summary } = applyDialogueDrafts(project, drafts);
    expect(summary.added).toBe(1);
    expect(summary.skippedPanels).toEqual(['p-1']);
    expect(summary.replacedPanels).toEqual([]);
    // p-1 人工内容原样保留；p-2 补入 AI 草稿
    expect(next.dialogues.find(item => item.panelId === 'p-1')!.text).toBe('人工已写');
    expect(next.dialogues.filter(item => item.panelId === 'p-2')).toHaveLength(1);
  });

  it('空文字对白不算「已有内容」（可见性 = 有文字）；全部跳过 → 原引用返回', () => {
    // 空文字只存在于内存编辑态（normalize 层会丢弃空文字，upsert 不重归一）
    const project = makeProject();
    const withEmpty = {
      ...project,
      dialogues: [{ ...makeDialogue({ panelId: 'p-1' }), text: '' }],
    };
    const drafts = [
      dialogueDraftFromProposal(project, project.panels[0]!, { order: 0, speakerId: 'narrator', type: 'caption', text: '补上', suggestedStyle: 'box-light' }, 0),
    ];
    const { project: next, summary } = applyDialogueDrafts(withEmpty, drafts);
    expect(summary.skippedPanels).toEqual([]);
    expect(summary.added).toBe(1);
    expect(next.dialogues).toHaveLength(2); // 空对白保留 + 新草稿

    const none = applyDialogueDrafts(project, []);
    expect(none.project).toBe(project);
  });

  it('overwrite=true（UI 二次确认后）：整格替换 + replacedPanels 如实记录', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ panelId: 'p-1', text: '旧内容' }),
    ] });
    const drafts = [
      dialogueDraftFromProposal(project, project.panels[0]!, { order: 0, speakerId: 'narrator', type: 'caption', text: '整体重排', suggestedStyle: 'box-light' }, 0),
    ];
    const { project: next, summary } = applyDialogueDrafts(project, drafts, { overwrite: true });
    expect(summary.replacedPanels).toEqual(['p-1']);
    expect(next.dialogues.filter(item => item.panelId === 'p-1')).toHaveLength(1);
    expect(next.dialogues.find(item => item.panelId === 'p-1')!.text).toBe('整体重排');
  });

  it('重写本格（panel 模式）：草稿只落目标格 + overwrite=true → 只替换该格，其他格原样', () => {
    // V4.2.13 残留修复的纯函数侧契约：此前 panel 模式 overwrite 恒 false，
    // 目标格必有旧对白 → fill 铁律整格跳过 → 建议永远应用不上（静默失败）。
    const project = makeProject({ dialogues: [
      makeDialogue({ panelId: 'p-1', text: '目标格旧对白' }),
      makeDialogue({ panelId: 'p-2', text: '别的格不许动' }),
    ] });
    const drafts = [
      dialogueDraftFromProposal(project, project.panels[1]!, { order: 1, speakerId: 'narrator', type: 'caption', text: '目标格新对白', suggestedStyle: 'box-light' }, 1),
    ];
    const { project: next, summary } = applyDialogueDrafts(project, drafts, { overwrite: true });
    expect(summary).toEqual({ added: 1, skippedPanels: [], replacedPanels: ['p-2'] });
    expect(next.dialogues.find(item => item.panelId === 'p-1')!.text).toBe('目标格旧对白');
    expect(next.dialogues.filter(item => item.panelId === 'p-2')).toHaveLength(1);
    expect(next.dialogues.find(item => item.panelId === 'p-2')!.text).toBe('目标格新对白');
  });
});

// ---------------------------------------------------------------------------
// Vision：本地确定性求解器
// ---------------------------------------------------------------------------

describe('solveVisionPlacement：无主体 → 安全默认泳道', () => {
  it('basis=default：按阅读顺序逐锚点落位，同格多气泡不叠放', () => {
    const suggestions = solveVisionPlacement(null, [
      makeDialogue({ id: 'd1', bubbleStyle: 'rounded' }),
      makeDialogue({ id: 'd2', bubbleStyle: 'rounded' }),
    ]);
    expect(suggestions.every(item => item.basis === 'default')).toBe(true);
    expect(suggestions[0].position).toEqual({ x: 0.26, y: 0.18 });
    expect(suggestions[1].position).toEqual({ x: 0.5, y: 0.18 }); // 上排从左到右
    // 未固定 size 的对白带建议盒（钳制范围内）
    expect(suggestions[0]!.size!.width).toBeGreaterThan(0);
    expect(suggestions[0]!.size!.width).toBeLessThanOrEqual(0.92);
  });

  it('已有固定 size 的对白不强塞建议盒（只动位置不动尺寸）', () => {
    const suggestions = solveVisionPlacement(null, [
      makeDialogue({ size: { width: 0.5, height: 0.3 } }),
    ]);
    expect(suggestions[0].size).toBeUndefined();
  });
});

describe('solveVisionPlacement：有主体 → 避让 + 尾巴指向', () => {
  const subjectAt = (x: number, y: number, width = 0.3, height = 0.4) => ({
    subjects: [{ position: { x, y, width, height } }],
  });

  it('主体占据上排左 → 气泡避让到重叠代价最小的其他锚点（basis=vision）', () => {
    // 主体盖住左上角锚点（0.26,0.18）→ 避让到无重叠锚点（0.74,0.18）
    const analysis = subjectAt(0.26, 0.18) as never;
    const [suggestion] = solveVisionPlacement(analysis, [makeDialogue({ bubbleStyle: 'rounded' })]);
    expect(suggestion.basis).toBe('vision');
    expect(suggestion.position).toEqual({ x: 0.74, y: 0.18 });
    // 避让后主体与气泡同高、在左侧 → 尾巴指头顶方向（top-left）
    expect(suggestion.tail).toBe('top-left');
  });

  it('主体在正下方 → bottom 尾；主体在上方 → top 尾；带尾样式才有尾巴', () => {
    const below = solveVisionPlacement(subjectAt(0.5, 0.9) as never, [makeDialogue({ bubbleStyle: 'rounded' })])[0];
    expect(['bottom-left', 'bottom-right']).toContain(below.tail);

    const above = solveVisionPlacement(subjectAt(0.5, 0.02, 0.3, 0.05) as never, [makeDialogue({ bubbleStyle: 'rounded' })])[0];
    expect(['top-left', 'top-right']).toContain(above.tail);

    // 旁白框恒无尾
    const box = solveVisionPlacement(subjectAt(0.5, 0.9) as never, [makeDialogue({ bubbleStyle: 'box' })])[0];
    expect(box.tail).toBeUndefined();
  });

  it('条形样式固定泳道：标题条顶部居中 / 字幕条底部居中，通栏宽，无尾巴', () => {
    const [title, subtitle] = solveVisionPlacement(null, [
      makeDialogue({ bubbleStyle: 'title-bar' }),
      makeDialogue({ bubbleStyle: 'subtitle-bar' }),
    ]);
    expect(title.position).toEqual({ x: 0.5, y: 0.12 });
    expect(title.size).toEqual({ width: 0.9, height: 0.14 });
    expect(title.tail).toBeUndefined();
    expect(subtitle.position).toEqual({ x: 0.5, y: 0.88 });
    // 字幕条期望高 0.12 → clampDialogueSize 高度下限钳到 0.14（与手工 resize 同一道闸）
    expect(subtitle.size).toEqual({ width: 0.9, height: 0.14 });
  });
});

describe('applyVisionPlacement：只改几何与来源标记', () => {
  it('position/size/tail 应用 + placementSource=vision；文字与样式绝不变', () => {
    const original = makeDialogue({
      text: '妈妈，功课好多呀……', bubbleStyle: 'rounded', fontStyle: { size: 18, weight: 700 },
      position: { x: 0.5, y: 0.5 },
    });
    const project = makeProject({ dialogues: [original] });
    const next = applyVisionPlacement(project, [{
      dialogueId: original.id, panelId: original.panelId,
      position: { x: 0.2, y: 0.2 }, size: { width: 0.4, height: 0.2 },
      tail: 'bottom-left', basis: 'vision',
    }]);
    const applied = next.dialogues[0]!;
    expect(applied.position).toEqual({ x: 0.2, y: 0.2 });
    expect(applied.size).toEqual({ width: 0.4, height: 0.2 });
    expect(applied.tail).toBe('bottom-left');
    expect(applied.placementSource).toBe('vision');
    // 文字 / 样式 / 字体一字不动
    expect(applied.text).toBe(original.text);
    expect(applied.bubbleStyle).toBe(original.bubbleStyle);
    expect(applied.fontStyle).toEqual(original.fontStyle);
  });

  it('applySize/applyTail=false：位置照常，尺寸 / 尾巴不动；钳制出界建议', () => {
    const original = makeDialogue({ size: { width: 0.5, height: 0.25 }, tail: 'top-right' });
    const project = makeProject({ dialogues: [original] });
    const next = applyVisionPlacement(project, [{
      dialogueId: original.id, panelId: original.panelId,
      position: { x: 5, y: -5 }, size: { width: 0.9, height: 0.9 },
      tail: 'bottom-left', basis: 'vision',
    }], { applySize: false, applyTail: false });
    const applied = next.dialogues[0]!;
    expect(applied.size).toEqual({ width: 0.5, height: 0.25 });
    expect(applied.tail).toBe('top-right');
    // 出界坐标钳回安全范围（与手工拖拽同一道闸）
    expect(applied.position.x).toBeLessThanOrEqual(0.94);
    expect(applied.position.y).toBeGreaterThanOrEqual(0.06);
  });

  it('建议未命中任何对白 → 原引用返回（无谓 updatedAt 抖动）', () => {
    const project = makeProject({ dialogues: [makeDialogue()] });
    expect(applyVisionPlacement(project, [{
      dialogueId: 'ghost', panelId: 'p-1', position: { x: 0.2, y: 0.2 }, basis: 'default',
    }])).toBe(project);
  });

  it('manual 来源不降级（Story Lock：视觉摆放只挪位置，人工出身标记保留）', () => {
    const manual = makeDialogue({ id: 'dlg-manual', panelId: 'p-1', placementSource: 'manual', text: '手写的' });
    const planner = makeDialogue({ id: 'dlg-planner', panelId: 'p-2', placementSource: 'planner', text: 'AI 写的' });
    const project = makeProject({ dialogues: [manual, planner] });
    const next = applyVisionPlacement(project, [
      { dialogueId: manual.id, panelId: manual.panelId, position: { x: 0.3, y: 0.3 }, basis: 'vision' },
      { dialogueId: planner.id, panelId: planner.panelId, position: { x: 0.7, y: 0.3 }, basis: 'vision' },
    ]);
    expect(next.dialogues.find(item => item.id === manual.id)!.placementSource).toBe('manual');
    expect(next.dialogues.find(item => item.id === planner.id)!.placementSource).toBe('vision');
  });
});

describe('proposeComicDialoguePlacement：逐格编排（注入 analyze，不冒充真实视觉）', () => {
  const okAnalyze: VisionAnalyzeFn = async () => ({
    ok: true,
    analysis: { subjects: [{ position: { x: 0.26, y: 0.18, width: 0.3, height: 0.4 } }] },
  }) as VisionAnalyzeResult;
  const failAnalyze: VisionAnalyzeFn = async () => ({ ok: false, error_message: 'blocked' }) as VisionAnalyzeResult;

  it('成图格真实分析 → analyzed=true + basis=vision 建议；无图格回落默认布局', async () => {
    const project = makeProject({
      panels: [
        makePanel({ id: 'p-img', imageAsset: { path: '/comic/p1.png', imageId: 'i1', taskId: 't1' } }),
        makePanel({ id: 'p-blank', order: 1 }),
      ],
      dialogues: [
        makeDialogue({ panelId: 'p-img' }),
        makeDialogue({ panelId: 'p-blank' }),
      ],
    });
    const { panels } = await proposeComicDialoguePlacement({ project, analyze: okAnalyze });
    expect(panels).toHaveLength(2);
    expect(panels[0]).toMatchObject({ panelId: 'p-img', analyzed: true });
    expect(panels[0].suggestions[0].basis).toBe('vision');
    expect(panels[1]).toMatchObject({ panelId: 'p-blank', analyzed: false });
    expect(panels[1].suggestions[0].basis).toBe('default');
  });

  it('单格分析失败 → analysisError 记录 + 默认布局兜底，不中断整批；无对白格跳过', async () => {
    const project = makeProject({
      panels: [
        makePanel({ id: 'p-a', imageAsset: { path: '/comic/a.png', imageId: 'i1', taskId: 't1' } }),
        makePanel({ id: 'p-b', order: 1 }),
        makePanel({ id: 'p-c', order: 2 }),
      ],
      dialogues: [
        makeDialogue({ panelId: 'p-a' }),
        makeDialogue({ panelId: 'p-c' }),
      ],
    });
    const { panels } = await proposeComicDialoguePlacement({ project, analyze: failAnalyze });
    // p-b 无对白被跳过；p-a 失败兜底；p-c 无图默认
    expect(panels.map(item => item.panelId)).toEqual(['p-a', 'p-c']);
    expect(panels[0].analyzed).toBe(false);
    expect(panels[0].analysisError).toContain('blocked');
    expect(panels[0].suggestions.every(item => item.basis === 'default')).toBe(true);
    expect(panels[1].analyzed).toBe(false);
  });
});
