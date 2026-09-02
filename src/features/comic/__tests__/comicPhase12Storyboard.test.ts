/**
 * AI 漫画 Phase 1.2-G 焦点测试（§37~§40 分镜 Panel-only 语义）：
 *  - applyComicPanelPatches：白名单字段 / 数组字段归一 / environmentText 显式清空 /
 *    空值忽略 / compiledPrompt 冻结剥离 / imageAsset 存在才标 stale；
 *  - normalizeComicPanelPatch：白名单外字段拒绝；
 *  - replaceProjectPanel：按 id 定点替换，未知 id 原样返回；
 *  - normalize：uiDraft.storyboard.patchTexts 挂载恢复（空值剥离 / 无草稿独立存活）。
 */

import { describe, it, expect } from 'vitest';
import {
  applyComicPanelPatches,
  normalizeComicPanelPatch,
  replaceProjectPanel,
} from '../domain';
import { normalizeComicPanel, normalizeComicProject } from '../normalize';
import type { ComicPanel, ComicProject } from '../types';

function makePanel(overrides: Partial<ComicPanel> = {}): ComicPanel {
  return normalizeComicPanel({
    id: 'panel-1',
    order: 0,
    scene: '汤圆走进会议室',
    characterIds: ['char-1'],
    shotType: '中景',
    camera: '平视',
    composition: '居中',
    characterActions: ['推门'],
    characterExpressions: ['紧张'],
    background: '办公室',
    environmentText: '例会室 3A',
    generationStatus: 'completed',
    imageAsset: { path: '/comic/p1.png', imageId: 'img-1', taskId: 'task-1' },
    compiledPrompt: 'frozen prompt v1',
    ...overrides,
  })!;
}

function makeProject(panels: ComicPanel[]): ComicProject {
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'editing',
    skillSnapshot: {
      name: '职场吐槽四格',
      comicForm: '四格漫画',
      visualStyle: '简笔粗线',
      characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
      layout: { arrangement: 'grid_4', panelCount: 4 },
    },
    characterSnapshots: [{
      id: 'char-1', name: '汤圆', description: '', role: '主角', source: 'ai',
      appearance: '', immutableTraits: [], mutableTraits: [], negativeConstraints: [],
      status: 'locked', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    }],
    characterBindings: { hero: 'char-1' },
    story: {
      title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
      beats: ['a', 'b'], endingType: 'twist', panelCount: 4,
    },
    panels,
    dialogues: [],
  })!;
}

describe('normalizeComicPanelPatch：字段白名单（§38.2）', () => {
  it('白名单内字段带 reason 通过；别名 path 也认', () => {
    expect(normalizeComicPanelPatch({ field: 'scene', value: '草地', reason: '用户要求' }))
      .toEqual({ field: 'scene', value: '草地', reason: '用户要求' });
    expect(normalizeComicPanelPatch({ path: 'camera', value: '俯视' }))
      .toEqual({ field: 'camera', value: '俯视', reason: undefined });
  });

  it('白名单外字段（id / order / generationStatus / compiledPrompt）一律拒绝', () => {
    expect(normalizeComicPanelPatch({ field: 'id', value: 'hack' })).toBeNull();
    expect(normalizeComicPanelPatch({ field: 'order', value: 9 })).toBeNull();
    expect(normalizeComicPanelPatch({ field: 'generationStatus', value: 'completed' })).toBeNull();
    expect(normalizeComicPanelPatch({ field: 'compiledPrompt', value: 'inject' })).toBeNull();
    expect(normalizeComicPanelPatch('不是对象')).toBeNull();
  });
});

describe('applyComicPanelPatches：单格白名单补丁（§38.2）', () => {
  it('文本字段变更：applied 记录字段；compiledPrompt 剥离；有图才标 stale', () => {
    const result = applyComicPanelPatches(makePanel(), [
      { field: 'scene', value: '摔到草地' },
    ]);
    expect(result.applied).toEqual(['scene']);
    expect(result.panel.scene).toBe('摔到草地');
    expect(result.panel.compiledPrompt).toBeUndefined();
    expect(result.panel.stale).toBe(true);
    expect(result.panel.imageAsset?.path).toBe('/comic/p1.png');
  });

  it('无成图的分镜内容变化不标 stale（没有旧图可过期）', () => {
    const result = applyComicPanelPatches(
      makePanel({ imageAsset: undefined, generationStatus: 'pending' }),
      [{ field: 'background', value: '公园' }],
    );
    expect(result.panel.background).toBe('公园');
    expect(result.panel.stale).toBeFalsy();
  });

  it('数组字段（动作/表情）走文本数组归一：字符串数组 / 逗号字符串 / 去空', () => {
    const result = applyComicPanelPatches(makePanel(), [
      { field: 'characterActions', value: ['跑', ' ', '摔倒'] },
      { field: 'characterExpressions', value: '惊讶；冒汗' },
    ]);
    expect(result.panel.characterActions).toEqual(['跑', '摔倒']);
    expect(result.panel.characterExpressions).toEqual(['惊讶', '冒汗']);
    expect(result.applied).toEqual(['characterActions', 'characterExpressions']);
  });

  it('environmentText null/空串 = 显式清空（这格不要画面内文字）；其余字段空值忽略', () => {
    const cleared = applyComicPanelPatches(makePanel(), [{ field: 'environmentText', value: null }]);
    expect(cleared.applied).toEqual(['environmentText']);
    expect(cleared.panel.environmentText).toBeUndefined();

    const clearedByEmpty = applyComicPanelPatches(makePanel(), [{ field: 'environmentText', value: '' }]);
    expect(clearedByEmpty.panel.environmentText).toBeUndefined();

    const ignored = applyComicPanelPatches(makePanel(), [{ field: 'scene', value: '   ' }]);
    expect(ignored.applied).toEqual([]);
    expect(ignored.ignored).toEqual(['scene']);
    expect(ignored.panel.scene).toBe('汤圆走进会议室');
    expect(ignored.panel.compiledPrompt).toBe('frozen prompt v1');
  });

  it('非法补丁混在列表里被丢弃，合法的照常应用', () => {
    const result = applyComicPanelPatches(makePanel(), [
      { field: 'order', value: 9 },
      'garbage',
      { field: 'shotType', value: '特写' },
    ]);
    expect(result.applied).toEqual(['shotType']);
    expect(result.panel.shotType).toBe('特写');
    expect(result.panel.order).toBe(0);
  });

  it('无实际变化（同值）→ applied 空，冻结 Prompt 不动', () => {
    const panel = makePanel();
    const result = applyComicPanelPatches(panel, [{ field: 'scene', value: panel.scene }]);
    expect(result.applied).toEqual([]);
    expect(result.panel).toBe(panel);
  });
});

describe('replaceProjectPanel：定点替换（§38.2 已应用分镜）', () => {
  it('只替换目标格；其他格与项目字段不动', () => {
    const project = makeProject([makePanel({ id: 'panel-1', order: 0 }), makePanel({ id: 'panel-2', order: 1 })]);
    const patched = applyComicPanelPatches(
      project.panels[1]!,
      [{ field: 'scene', value: '新场景' }],
    ).panel;
    const next = replaceProjectPanel(project, patched);
    expect(next.panels[0]!.id).toBe('panel-1');
    expect(next.panels[0]!.scene).toBe('汤圆走进会议室');
    expect(next.panels[1]!.scene).toBe('新场景');
    expect(next.panels[1]!.stale).toBe(true);
    expect(next).not.toBe(project);
  });

  it('未知 id 原样返回（不伪造格）', () => {
    const project = makeProject([makePanel()]);
    expect(replaceProjectPanel(project, makePanel({ id: 'ghost' }))).toBe(project);
  });
});

describe('normalize：uiDraft.storyboard.patchTexts 挂载恢复（§30/§85）', () => {
  it('panelId → 输入文本往返保留；空值剥离；无分镜草稿也独立存活', () => {
    const restored = normalizeComicProject({
      id: 'p1', name: '第一期', stage: 'editing',
      skillSnapshot: {
        name: '职场吐槽四格', comicForm: '四格漫画', visualStyle: '简笔粗线',
        characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
        layout: { arrangement: 'grid_4', panelCount: 4 },
      },
      characterSnapshots: [], characterBindings: {},
      panels: [], dialogues: [],
      uiDraft: { storyboard: { patchTexts: { 'panel-1': ' 不要掉水里 ', 'panel-2': '   ' } } },
    })!;
    expect(restored.uiDraft?.storyboard?.patchTexts).toEqual({ 'panel-1': '不要掉水里' });
    expect(restored.uiDraft?.storyboard?.storyDraft).toBeUndefined();
    expect(restored.uiDraft?.storyboard?.panels).toBeUndefined();
  });

  it('全空 patchTexts 且无草稿 → storyboard 键整体剥离', () => {
    const restored = normalizeComicProject({
      id: 'p1', name: '第一期', stage: 'editing',
      skillSnapshot: {
        name: '职场吐槽四格', comicForm: '四格漫画', visualStyle: '简笔粗线',
        characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
        layout: { arrangement: 'grid_4', panelCount: 4 },
      },
      characterSnapshots: [], characterBindings: {},
      panels: [], dialogues: [],
      uiDraft: { storyboard: { patchTexts: { 'panel-1': '' } } },
    })!;
    expect(restored.uiDraft).toBeUndefined();
  });
});
