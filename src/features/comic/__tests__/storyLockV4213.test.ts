/**
 * V4.2.13 Story Lock（对白单一事实源 / 防 Story Drift）领域测试：
 *  - §A comicStoryFingerprint：内容级指纹（panelCount 不入指纹 —— repairStoryboard
 *    会按现实格数回写，同故事草稿不能被误拒）；
 *  - §B applyStoryToProject：同故事重出分镜时——种子标 story_seed、人工 / planner /
 *    vision 对白按格序迁移保留、种子只补空白格；故事重新确认后的过期分镜草稿
 *    直接拒绝（R1：不复活旧 story）；
 *  - §C upsertDialogue：story_seed 一经人工改动即升级 manual（人工优先级最高）；
 *  - §D ComicStoryboardStage 挂载守卫（SSR 行为测试）：过期分镜草稿不复活。
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  normalizeComicDialogue,
  normalizeComicPanel,
  normalizeComicProject,
  normalizeComicSkill,
  normalizeComicStory,
} from '../normalize';
import { applyStoryToProject, comicStoryFingerprint, upsertDialogue } from '../domain';
import ComicStoryboardStage from '../components/ComicStoryboardStage';
import type { ComicDialogue, ComicProject, ComicStory } from '../types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeStory(overrides: Record<string, unknown> = {}): ComicStory {
  const story = normalizeComicStory({
    title: '鸭梨山大',
    topic: '一只长得像梨的小圆鸭',
    summary: '小圆鸭背上了鸭梨。',
    beats: ['开场', '冲突', '反转'],
    characterIds: ['char-1'],
    endingType: 'warm',
    panelCount: 3,
    ...overrides,
  });
  expect(story).not.toBeNull();
  return story as ComicStory;
}

function makeDialogue(overrides: Record<string, unknown> = {}): ComicDialogue {
  const dialogue = normalizeComicDialogue({
    id: 'dlg-1',
    panelId: 'p-1',
    text: '妈妈，功课好多呀……',
    ...overrides,
  });
  expect(dialogue).not.toBeNull();
  return dialogue as ComicDialogue;
}

function makeProject(options: { story?: ComicStory | null; dialogues?: ComicDialogue[] } = {}): ComicProject {
  const skill = normalizeComicSkill({
    id: 'skill-1', name: '四格', comicForm: '四格漫画', version: 1,
  })!;
  return normalizeComicProject({
    id: 'project-1',
    name: '第一期',
    stage: 'storyboard_applied',
    skillSnapshot: skill,
    story: options.story === undefined ? makeStory() : options.story,
    panels: [
      { id: 'p-1', order: 0, scene: '开场' },
      { id: 'p-2', order: 1, scene: '冲突' },
      { id: 'p-3', order: 2, scene: '反转' },
    ],
    dialogues: options.dialogues ?? [],
  })!;
}

function newPanels(count: number) {
  return Array.from({ length: count }, (_, index) =>
    normalizeComicPanel({ id: `new-${index + 1}`, order: index, scene: `新第${index + 1}格` })!);
}

// ---------------------------------------------------------------------------
// §A comicStoryFingerprint
// ---------------------------------------------------------------------------

describe('§A comicStoryFingerprint（内容级指纹）', () => {
  it('同内容恒同指纹；重新 normalize 的等价 story 指纹不变', () => {
    const story = makeStory();
    expect(comicStoryFingerprint(makeStory())).toBe(comicStoryFingerprint(story));
    expect(comicStoryFingerprint(story)).toBe(comicStoryFingerprint({ ...story }));
  });

  it('任一叙事字段变化 → 指纹变化（title/topic/summary/endingType/beats/characterIds）', () => {
    const base = comicStoryFingerprint(makeStory());
    expect(comicStoryFingerprint(makeStory({ title: '另一个故事' }))).not.toBe(base);
    expect(comicStoryFingerprint(makeStory({ topic: '换个主题' }))).not.toBe(base);
    expect(comicStoryFingerprint(makeStory({ summary: '改了结局' }))).not.toBe(base);
    expect(comicStoryFingerprint(makeStory({ endingType: 'twist' }))).not.toBe(base);
    expect(comicStoryFingerprint(makeStory({ beats: ['开场', '冲突', '大反转'] }))).not.toBe(base);
    expect(comicStoryFingerprint(makeStory({ characterIds: ['char-1', 'char-2'] }))).not.toBe(base);
  });

  it('panelCount 不入指纹：repairStoryboard 按现实格数回写 panelCount 不算换故事', () => {
    expect(comicStoryFingerprint(makeStory({ panelCount: 2 }))).toBe(comicStoryFingerprint(makeStory({ panelCount: 9 })));
  });
});

// ---------------------------------------------------------------------------
// §B applyStoryToProject（Story Lock 语义）
// ---------------------------------------------------------------------------

describe('§B applyStoryToProject：同故事重出 = 保留人工对白 + 种子只补空白', () => {
  it('incoming 无标记种子 → story_seed；显式 planner / vision 标记原样保留', () => {
    const next = applyStoryToProject(makeProject(), makeStory(), newPanels(3), [
      makeDialogue({ id: 'seed-1', panelId: 'new-1' }),
      makeDialogue({ id: 'ai-1', panelId: 'new-2', placementSource: 'planner' }),
      makeDialogue({ id: 'vi-1', panelId: 'new-3', placementSource: 'vision' }),
    ]).project;
    const byId = new Map(next.dialogues.map(item => [item.id, item]));
    expect(byId.get('seed-1')!.placementSource).toBe('story_seed');
    expect(byId.get('ai-1')!.placementSource).toBe('planner');
    expect(byId.get('vi-1')!.placementSource).toBe('vision');
  });

  it('人工 / planner / vision / 旧数据无标记 对白按格序迁移到新分镜同序格（panelId 重映射）', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ id: 'manual-1', panelId: 'p-1', placementSource: 'manual' }),
      makeDialogue({ id: 'ai-2', panelId: 'p-2', placementSource: 'planner' }),
      makeDialogue({ id: 'legacy-3', panelId: 'p-3' }), // 旧数据无标记 → 视同人工保留
    ] });
    const { project: next, preservedDialogues } = applyStoryToProject(
      project, makeStory(), newPanels(3),
      [makeDialogue({ id: 'seed-1', panelId: 'new-1', text: '新种子' })],
    );
    expect(preservedDialogues).toBe(3);
    const byId = new Map(next.dialogues.map(item => [item.id, item]));
    expect(byId.get('manual-1')!.panelId).toBe('new-1'); // order 0 → new-1
    expect(byId.get('ai-2')!.panelId).toBe('new-2');
    expect(byId.get('legacy-3')!.panelId).toBe('new-3');
    // 三个格序都有保留对白 → 没有空白格，种子不灌入（种子只补空白）
    expect(byId.has('seed-1')).toBe(false);
  });

  it('未动过的 story_seed 对白不保留（新种子接管）；种子只补没有保留对白的空白格', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ id: 'seed-old-1', panelId: 'p-1', placementSource: 'story_seed' }),
      makeDialogue({ id: 'manual-2', panelId: 'p-2', placementSource: 'manual', text: '人工定稿' }),
    ] });
    const next = applyStoryToProject(project, makeStory(), newPanels(3), [
      makeDialogue({ id: 'seed-new-1', panelId: 'new-1', text: '新种子 1' }),
      makeDialogue({ id: 'seed-new-2', panelId: 'new-2', text: '新种子 2（应被滤掉）' }),
      makeDialogue({ id: 'seed-new-3', panelId: 'new-3', text: '空白格种子' }),
    ]).project;
    // order 0：旧种子淘汰、新种子接管；order 1：人工定稿保留、种子滤掉；order 2：空白补种子
    expect(next.dialogues.map(item => item.id)).toEqual(['manual-2', 'seed-new-1', 'seed-new-3']);
    expect(next.dialogues.find(item => item.id === 'manual-2')!.text).toBe('人工定稿');
  });

  it('新分镜格数变少：超出新格序的人工对白随旧代淘汰（不悬空不虚增）', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ id: 'keep-1', panelId: 'p-1', placementSource: 'manual' }),
      makeDialogue({ id: 'drop-3', panelId: 'p-3', placementSource: 'manual' }),
    ] });
    const { project: next, preservedDialogues } = applyStoryToProject(
      project, makeStory(), newPanels(2), [],
    );
    expect(preservedDialogues).toBe(1);
    expect(next.dialogues.map(item => item.id)).toEqual(['keep-1']);
    expect(next.dialogues[0].panelId).toBe('new-1');
  });

  it('R1 过期分镜草稿拒绝：故事重新确认后，旧 story 的分镜草稿不应用（project 引用不变）', () => {
    const project = makeProject(); // 已确认故事 A
    const staleDraftStory = makeStory({ title: '旧标题故事' });
    const result = applyStoryToProject(project, staleDraftStory, newPanels(3), []);
    expect(result.rejected).toContain('旧故事');
    expect(result.project).toBe(project); // 原样返回，零改动
    // 同指纹（哪怕 panelCount 被 repair 回写）→ 正常应用
    const sameStoryDraft = makeStory({ panelCount: 2 });
    const applied = applyStoryToProject(project, sameStoryDraft, newPanels(2), []);
    expect(applied.rejected).toBeUndefined();
    expect(applied.project.panels.map(panel => panel.id)).toEqual(['new-1', 'new-2']);
  });
});

// ---------------------------------------------------------------------------
// §C upsertDialogue（人工修改优先级最高）
// ---------------------------------------------------------------------------

describe('§C upsertDialogue：story_seed 一经人工改动即升级 manual', () => {
  it('编辑 story_seed → manual；manual / planner / vision 标记不被覆盖', () => {
    const project = makeProject({ dialogues: [
      makeDialogue({ id: 'seed-1', placementSource: 'story_seed' }),
      makeDialogue({ id: 'manual-1', placementSource: 'manual' }),
      makeDialogue({ id: 'ai-1', placementSource: 'planner' }),
      makeDialogue({ id: 'vi-1', placementSource: 'vision' }),
    ] });
    const byId = (current: ComicProject, id: string) =>
      current.dialogues.find(item => item.id === id)!;

    const edited = upsertDialogue(project, { ...byId(project, 'seed-1'), text: '人工改写' });
    expect(byId(edited, 'seed-1').placementSource).toBe('manual');
    expect(byId(edited, 'seed-1').text).toBe('人工改写');

    const reEdited = upsertDialogue(edited, { ...byId(edited, 'manual-1'), text: '再改' });
    expect(byId(reEdited, 'manual-1').placementSource).toBe('manual');
    expect(byId(reEdited, 'ai-1').placementSource).toBe('planner');
    expect(byId(reEdited, 'vi-1').placementSource).toBe('vision');
  });

  it('新增对白不带标记 → 保持无标记（标记由创建方负责：放置模式 manual / planner / vision）', () => {
    const project = makeProject();
    const added = upsertDialogue(project, makeDialogue({ placementSource: undefined }));
    expect(added.dialogues[0].placementSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §D ComicStoryboardStage 挂载守卫（R1：过期分镜草稿不复活）
// ---------------------------------------------------------------------------

describe('§D ComicStoryboardStage 挂载：过期分镜草稿不复活（指纹校验）', () => {
  const renderStage = (project: ComicProject) => renderToStaticMarkup(createElement(ComicStoryboardStage, {
    project,
    onApply: () => {},
    onPatch: () => {},
    onPanelMove: () => {},
    onDraft: () => {},
  }));

  function projectWithDraft(draftStory: ComicStory, currentStory: ComicStory): ComicProject {
    return {
      ...makeProject({ story: currentStory }),
      uiDraft: {
        storyboard: {
          storyDraft: draftStory,
          panels: [
            normalizeComicPanel({ id: 'draft-1', order: 0, scene: '草稿格 1' })!,
            normalizeComicPanel({ id: 'draft-2', order: 1, scene: '草稿格 2' })!,
          ],
          dialogues: [],
          repairs: [],
        },
      },
    };
  }

  it('草稿故事 = 已确认故事 → 挂载恢复草稿（分镜草稿（2 格））', () => {
    const markup = renderStage(projectWithDraft(makeStory(), makeStory()));
    expect(markup).toContain('分镜草稿（2 格）');
  });

  it('故事重新确认后：旧草稿指纹不符 → 丢弃，回到「当前分镜」（不复活旧 story）', () => {
    const markup = renderStage(projectWithDraft(
      makeStory({ title: '旧标题故事' }),
      makeStory({ title: '新标题故事' }),
    ));
    expect(markup.includes('分镜草稿（')).toBe(false);
    expect(markup).toContain('当前分镜（3 格）');
  });
});
