/**
 * 分镜顺序完整性测试（V4.2.12 §38~§46）——「排版顺序唯一事实 = panel.order」：
 *  - comicPanelsByOrder：有效分镜（非 stale）按 order 排序，全渲染点统一入口；
 *  - moveProjectPanel：只交换相邻两格的 order——id / 对白 panelId 绑定 / imageAsset /
 *    compiledPrompt / stale 全部不动（调整顺序 ≠ 重新生成）；边界 no-op 引用不变；
 *  - 完成顺序回放：任务槽位按 3,1,4,2 完成回写后，Composer 布局（computePageLayouts）
 *    仍是 1,2,3,4 的阅读序（左上1 右上2 左下3 右下4）——任务完成顺序永不改变排版；
 *  - 手动重排后布局跟随 order，资产与对白绑定原样。
 */

import { describe, it, expect } from 'vitest';
import { comicPanelsByOrder, moveProjectPanel, upsertDialogue } from '../domain';
import { applyComicTaskResults } from '../generation';
import { computePageLayouts } from '../comicExport';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';
import type { ImageRecord, SubTask, Task, TaskBatchItem } from '../../../types';

const IMAGE_IDS = ['img-0', 'img-1', 'img-2', 'img-3'] as const;

function makeProject(): ComicProject {
  const skill = normalizeComicSkill({
    name: '顺序四格',
    visualStyle: '简笔粗线',
    layout: { panelCount: 4, arrangement: 'grid_4' },
    exportDefaults: { canvasRatio: '1:1', background: '#ffffff' },
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
  });
  const hero = normalizeComicCharacter({ id: 'char-1', name: '汤圆', status: 'locked', appearance: '圆脸' })!;
  const panelSeed = [
    { id: 'panel-0', order: 0, scene: '开场' },
    { id: 'panel-1', order: 1, scene: '发展' },
    { id: 'panel-2', order: 2, scene: '转折' },
    { id: 'panel-3', order: 3, scene: '结尾' },
  ];
  const panels = panelSeed.map((seed, index) => normalizeComicPanel({
    ...seed,
    characterIds: ['char-1'],
    generationStatus: 'completed',
    compiledPrompt: `frozen-${seed.id}`,
    imageAsset: { path: `D:/lib/${seed.id}.png`, imageId: IMAGE_IDS[index], taskId: 'task-1' },
  })!);
  // 上一代 stale 副本：永不参与排序与回写
  panels.push(normalizeComicPanel({
    id: 'panel-old', order: 4, scene: '旧开场', stale: true,
    generationStatus: 'completed',
    imageAsset: { path: 'D:/lib/old.png', imageId: 'img-old', taskId: 'task-0' },
  })!);
  return normalizeComicProject({
    id: 'p-order',
    name: '顺序第一期',
    stage: 'editing',
    skillSnapshot: skill,
    characterSnapshots: [hero],
    characterBindings: { hero: 'char-1' },
    story: { title: 't', topic: 't', summary: 's', characterIds: ['char-1'], beats: ['a'], endingType: 'twist', panelCount: 4 },
    panels,
    dialogues: [
      {
        id: 'dlg-1', panelId: 'panel-2', speakerId: 'char-1', type: 'speech',
        text: '第三格的对白', position: { x: 0.4, y: 0.2 }, alignment: 'center',
        fontStyle: { size: 16, weight: 500 }, bubbleStyle: 'rounded', tail: 'auto',
      },
      {
        id: 'dlg-2', panelId: 'panel-0', speakerId: 'narrator', type: 'caption',
        text: '第一格旁白', position: { x: 0.5, y: 0.1 }, alignment: 'center',
        fontStyle: { size: 14, weight: 500 }, bubbleStyle: 'box',
      },
    ],
  })!;
}

describe('comicPanelsByOrder：排序唯一入口', () => {
  it('有效分镜按 order 升序；stale 副本永不入场', () => {
    const project = makeProject();
    expect(comicPanelsByOrder(project).map(panel => panel.id)).toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3']);
    expect(comicPanelsByOrder(project).every(panel => !panel.stale)).toBe(true);
  });

  it('不修改原数组（纯函数）', () => {
    const project = makeProject();
    const before = project.panels.map(panel => panel.id).join(',');
    comicPanelsByOrder(project);
    expect(project.panels.map(panel => panel.id).join(',')).toBe(before);
  });
});

describe('moveProjectPanel：只改排版，不碰资产 / 对白绑定', () => {
  it('与相邻格交换 order：其余字段与 panelId 绑定原样', () => {
    const project = makeProject();
    const moved = moveProjectPanel(project, 'panel-1', 'up');
    expect(comicPanelsByOrder(moved).map(panel => panel.id)).toEqual(['panel-1', 'panel-0', 'panel-2', 'panel-3']);
    // id 不变（对白 panelId 绑定稳定）；对白数组零变化
    expect(moved.dialogues).toBe(project.dialogues);
    for (const panel of moved.panels) {
      const origin = project.panels.find(item => item.id === panel.id)!;
      expect(panel.imageAsset).toBe(origin.imageAsset);
      expect(panel.compiledPrompt).toBe(origin.compiledPrompt);
      expect(panel.stale).toBe(origin.stale);
    }
    // 不产生新 stale（不触发任何重生成语义）
    expect(moved.panels.filter(panel => panel.stale).length).toBe(1); // 仅原有的旧副本
  });

  it('首格上移 / 末格下移 = no-op 返回原引用', () => {
    const project = makeProject();
    expect(moveProjectPanel(project, 'panel-0', 'up')).toBe(project);
    expect(moveProjectPanel(project, 'panel-3', 'down')).toBe(project);
    expect(moveProjectPanel(project, 'panel-404', 'up')).toBe(project);
  });

  it('stale 副本不可移动（不参与排序序列）', () => {
    const project = makeProject();
    expect(moveProjectPanel(project, 'panel-old', 'up')).toBe(project);
  });
});

describe('§42~§44 完成顺序 ≠ 排版顺序（P0 铁律回放）', () => {
  /** 系列任务夹具：batch_items / sub_tasks 按「完成顺序」排列（这里 = 3,1,4,2 → 0 基 2,0,3,1）。 */
  function completionOrderTask(project: ComicProject, completionPanelIds: string[], images: ImageRecord[]): Task {
    const subTasks: SubTask[] = completionPanelIds.map((panelId, index) => ({
      index,
      status: 'completed',
      image_id: project.panels.find(panel => panel.id === panelId)!.imageAsset!.imageId,
      error: null,
    }));
    const batchItems: TaskBatchItem[] = completionPanelIds.map((panelId, index) => ({
      id: `item-${index}`,
      label: `第 ${index + 1} 槽`,
      prompt_delta: '',
      variables: { panelId },
    }));
    return {
      id: 'task-series',
      prompt: 'p', negative_prompt: '',
      size: '1024x1024', quality: 'auto', output_format: 'png', count: completionPanelIds.length,
      status: 'completed', created_at: '2026-01-01T00:00:00Z', output_dir: 'D:/lib',
      success_count: completionPanelIds.length, failed_count: 0,
      sub_tasks: subTasks, task_type: 'edit', source_images: [],
      batch_items: batchItems,
      execution_snapshot: {
        prompt_deltas: [], batch_items: [],
        comic: { projectId: project.id, kind: 'panels' },
      } as unknown as Task['execution_snapshot'],
    };
  }

  function imagesFor(project: ComicProject): ImageRecord[] {
    return project.panels
      .filter(panel => panel.imageAsset)
      .map(panel => ({
        id: panel.imageAsset!.imageId,
        task_id: 'task-series',
        local_path: panel.imageAsset!.path,
        file_name: `${panel.id}.png`,
        created_at: '2026-01-01T00:00:00Z',
        status: 'saved',
        source_kind: 'output' as const,
      }));
  }

  it('任务槽位按 3,1,4,2 完成 → Composer 布局仍是 1,2,3,4 阅读序', () => {
    const project = makeProject();
    // 生成时间线回放：去掉已落图状态，模拟「分镜刚规划完」
    const pristine: ComicProject = {
      ...project,
      panels: project.panels.map(panel => ({
        ...panel,
        generationStatus: 'pending' as const,
        imageAsset: undefined,
      })),
    };
    const task = completionOrderTask(project, ['panel-2', 'panel-0', 'panel-3', 'panel-1'], imagesFor(project));
    const applied = applyComicTaskResults(pristine, task, imagesFor(project));
    expect(applied.changed).toBe(true);
    expect(applied.imagesApplied).toBe(4);

    const layouts = computePageLayouts(applied.project);
    expect(layouts).toHaveLength(1);
    const slots = layouts[0]!.slots;
    // 阅读序 = order 序：左上1 右上2 左下3 右下4
    expect(slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3']);
    // 各格拿到的是自己的图（完成顺序不串图）
    for (const panel of comicPanelsByOrder(applied.project)) {
      expect(panel.imageAsset!.imageId).toBe(IMAGE_IDS[panel.order]);
    }
    // 2×2 几何：右上格 x 大于左上、左下格 y 大于左上
    expect(slots[1]!.x).toBeGreaterThan(slots[0]!.x);
    expect(slots[2]!.y).toBeGreaterThan(slots[0]!.y);
    expect(slots[3]!.x).toBeGreaterThan(slots[2]!.x);
  });

  it('手动重排（末格上移两次到第 2 位）→ 布局跟随 order，资产与对白绑定原样', () => {
    const project = makeProject();
    const reordered = moveProjectPanel(moveProjectPanel(project, 'panel-3', 'up'), 'panel-3', 'up');
    expect(comicPanelsByOrder(reordered).map(panel => panel.id)).toEqual(['panel-0', 'panel-3', 'panel-1', 'panel-2']);
    const slots = computePageLayouts(reordered)[0]!.slots;
    expect(slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-3', 'panel-1', 'panel-2']);
    // panel-2 的对白仍绑在 panel-2（换位不换绑定）
    expect(reordered.dialogues.find(dialogue => dialogue.id === 'dlg-1')!.panelId).toBe('panel-2');
    expect(reordered.panels.find(panel => panel.id === 'panel-2')!.imageAsset!.imageId).toBe('img-2');
  });

  it('重排 + 对白编辑叠加：图片资产引用零变化（两项操作都不触发生图）', () => {
    const project = makeProject();
    const combined = upsertDialogue(
      moveProjectPanel(project, 'panel-2', 'up'),
      { ...project.dialogues[0]!, text: '改字（终稿）' },
    );
    for (const panel of combined.panels) {
      expect(panel.imageAsset).toBe(project.panels.find(item => item.id === panel.id)!.imageAsset);
    }
    expect(combined.panels).not.toBe(project.panels); // order 确实变了
  });
});
