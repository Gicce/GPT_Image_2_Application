/**
 * 漫画任务构建 / 结果回写测试（Phase 8/9，验收 D / J + D-006 两段编排）：
 *  - Anchor 任务：batch-of-1、mode='anchor'（无 anchor 自参考）、图生图路由边界；
 *  - 系列任务：门禁（Anchor 锁定）、锚点格不重出、每槽 source_images 首位 = 锚点图、
 *    comic 溯源标记 + panelId 逐槽变量 + promptSource='comic-compiled'；
 *  - 单格重绘：必须已锁 Anchor、继承一致性档案；
 *  - 结果回写：幂等 + 结构共享、失败映射、stale 隔离、图库记录缺失不落图；
 *  - 锚点审定载荷 → lockAnchor 冻结一致性档案。
 */

import { describe, it, expect } from 'vitest';
import type { ImageRecord, Task } from '../../../types';
import {
  buildAnchorTask,
  buildPanelRegenTask,
  buildPanelSeriesTask,
  freezeCompiledPrompt,
} from '../comicTask';
import { applyComicTaskResults, buildAnchorConfirmation } from '../generation';
import { lockAnchor } from '../domain';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

const CTX = { outputDir: '/out/comic' };

function makeProject(options: {
  anchor?: boolean;
  finalizeAnchorPanel?: boolean;
  characterRef?: boolean;
  panelCount?: number;
  staleFirst?: boolean;
} = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线，低饱和暖色',
    consistencyRules: ['线条粗细一致'],
    generationRules: { negativeConstraints: ['水印'], environmentTextAllowed: false },
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true, displayRule: '全身出场' },
    ],
  });
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    status: 'locked',
    appearance: '奶油黄圆脸猫',
    immutableTraits: ['奶油黄短毛', '圆脸'],
    referenceImage: options.characterRef === false
      ? undefined
      : { path: '/refs/tangyuan.png', label: '定妆照' },
  });
  const panelCount = options.panelCount ?? 2;
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
    stale: options.staleFirst && index === 0 ? true : undefined,
    imageAsset: options.finalizeAnchorPanel && index === 0
      ? { path: '/comic/anchor.png', imageId: 'img-a', taskId: 'task-anchor' }
      : undefined,
  })!);
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: options.anchor ? 'generating_panels' : 'generating_anchor',
    skillSnapshot: skill,
    characterSnapshots: [character!],
    characterBindings: { hero: 'char-1' },
    story: { title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'], beats: ['a', 'b'], endingType: 'twist', panelCount },
    panels,
    dialogues: [],
    consistency: options.anchor
      ? {
        anchor: { panelId: 'panel-0', path: '/comic/anchor.png', imageId: 'img-a', taskId: 'task-anchor', lockedAt: '2026-08-30T02:00:00.000Z' },
        characterReferences: [],
        generationParams: { size: '1024x1536', quality: 'high', format: 'png' },
      }
      : undefined,
  })!;
}

interface FakeTaskInput {
  id?: string;
  marker?: Record<string, unknown> | null;
  slots?: Array<{ panelId: string; status: Task['sub_tasks'][number]['status']; imageId?: string; error?: string }>;
}

function makeFakeTask(input: FakeTaskInput): Task {
  const slots = input.slots ?? [];
  return {
    id: input.id ?? 'task-x',
    prompt: 'p',
    negative_prompt: 'n',
    task_source: 'comic',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    count: slots.length,
    status: slots.every(s => s.status === 'completed') ? 'completed' : 'running',
    created_at: '2026-08-30T03:00:00.000Z',
    output_dir: '/out/comic',
    success_count: slots.filter(s => s.status === 'completed').length,
    failed_count: slots.filter(s => s.status === 'failed').length,
    sub_tasks: slots.map((slot, index) => ({
      index,
      status: slot.status,
      ...(slot.imageId ? { image_id: slot.imageId } : {}),
      ...(slot.error ? { error: slot.error } : {}),
    })),
    task_type: 'edit',
    source_images: [],
    batch_items: slots.map(slot => ({
      id: slot.panelId,
      label: `panel ${slot.panelId}`,
      prompt_delta: '',
      variables: { panelId: slot.panelId },
    })),
    execution_snapshot: input.marker === null
      ? undefined
      : {
        schemaVersion: 1,
        userRequirement: '漫画',
        positivePrompt: 'p',
        negativePrompt: 'n',
        effectivePrompt: 'p',
        promptSource: 'comic-compiled',
        referenceImages: [],
        generationParams: {},
        createdAt: '2026-08-30T03:00:00.000Z',
        ...(input.marker ? { comic: input.marker } : {}),
      },
  } as Task;
}

function makeImage(id: string, path: string): ImageRecord {
  return { id, task_id: 'task-x', local_path: path, file_name: `${id}.png`, created_at: '2026-08-30T03:01:00.000Z', status: 'transparent' };
}

describe('buildAnchorTask（Phase 8）', () => {
  it('缺分镜直接报错', () => {
    const project = makeProject();
    const empty = { ...project, panels: [] };
    expect(() => buildAnchorTask(empty, CTX)).toThrow('缺少分镜');
  });

  it('batch-of-1 + anchor 标记 + comic 来源 + 漫画编译 promptSource', () => {
    const project = makeProject();
    const { params, panelId, compiled } = buildAnchorTask(project, CTX);
    expect(panelId).toBe('panel-0');
    expect(params.count).toBe(1);
    expect(params.task_source).toBe('comic');
    expect(params.execution_mode).toBe('batch');
    expect(params.batch_items).toHaveLength(1);
    expect(params.batch_items![0]!.id).toBe('panel-0');
    expect(params.batch_items![0]!.variables).toEqual({ panelId: 'panel-0' });
    expect(params.execution_snapshot?.comic).toMatchObject({ projectId: 'p1', kind: 'anchor', panelId: 'panel-0', skillName: '职场吐槽四格', storyTitle: '周一例会' });
    expect(params.execution_snapshot?.promptSource).toBe('comic-compiled');
    expect(params.execution_snapshot?.items).toHaveLength(1);
    expect(compiled.positive).toBe(params.batch_items![0]!.prompt_override);
    expect(params.task_plan_summary).toContain('首格锚点');
  });

  it('角色有参考图 → edit 路由，source_images = 角色参考', () => {
    const project = makeProject();
    const { params } = buildAnchorTask(project, CTX);
    expect(params.task_type).toBe('edit');
    expect(params.source_images).toEqual(['/refs/tangyuan.png']);
    expect(params.batch_items![0]!.source_images).toEqual(['/refs/tangyuan.png']);
  });

  it('角色无参考图 → generate 路由（纯文生图，无空源图 edit）', () => {
    const project = makeProject({ characterRef: false });
    const { params } = buildAnchorTask(project, CTX);
    expect(params.task_type).toBe('generate');
    expect(params.source_images).toEqual([]);
    expect(params.batch_items![0]!.source_images).toBeUndefined();
  });

  it('stale 首格被跳过，锚点取首个活动格', () => {
    const project = makeProject({ staleFirst: true });
    const { panelId } = buildAnchorTask(project, CTX);
    expect(panelId).toBe('panel-1');
  });

  it('生成参数回落 consistency.generationParams', () => {
    const project = makeProject({ anchor: true });
    const { params } = buildAnchorTask(project, CTX);
    expect(params.size).toBe('1024x1536');
    expect(params.quality).toBe('high');
    expect(params.output_format).toBe('png');
  });
});

describe('buildPanelSeriesTask（Phase 9，验收 J 门禁）', () => {
  it('Anchor 未锁定 → 拒绝并列出阻塞项', () => {
    const project = makeProject();
    expect(() => buildPanelSeriesTask(project, CTX)).toThrow('第一格尚未确认');
  });

  it('V4.2.11 §F 默认（skipAnchor）：无锚档案一次性提交全部格，每槽参考=角色定妆照，Prompt 无页面级拼图词', () => {
    const project = makeProject({ panelCount: 4 });
    const { params, panelIds, compiledByPanelId } = buildPanelSeriesTask(project, CTX, { skipAnchor: true });
    expect(panelIds).toHaveLength(4);
    expect(params.count).toBe(4);
    expect(params.batch_items).toHaveLength(4);
    for (const item of params.batch_items!) {
      expect(item!.source_images).toEqual(['/refs/tangyuan.png']);
      expect(item!.prompt_override).not.toContain('四宫格');
      expect(item!.prompt_override).toContain('单格画面（强制）');
    }
    for (const compiled of Object.values(compiledByPanelId)) {
      expect(compiled.positive).not.toContain('画风一致性（强制）');
    }
    expect(params.execution_snapshot?.comic?.kind).toBe('panels');
  });

  it('Anchor 已锁定：剩余格批量，锚点格不重出，锚点图恒为每槽首源图', () => {
    const project = makeProject({ anchor: true, finalizeAnchorPanel: true, panelCount: 3 });
    const { params, panelIds, compiledByPanelId } = buildPanelSeriesTask(project, CTX);
    expect(panelIds).toEqual(['panel-1', 'panel-2']);
    expect(params.count).toBe(2);
    expect(params.task_type).toBe('edit');
    expect(params.task_plan_summary).toContain('系列分镜（2 格）');
    for (const item of params.batch_items!) {
      expect(item.source_images![0]).toBe('/comic/anchor.png');
    }
    expect(params.batch_items![1]!.source_images).toEqual(['/comic/anchor.png', '/refs/tangyuan.png']);
    expect(params.execution_snapshot?.comic).toMatchObject({ projectId: 'p1', kind: 'panels' });
    expect((params.execution_snapshot?.comic as Record<string, unknown>).panelId).toBeUndefined();
    expect(Object.keys(compiledByPanelId)).toEqual(['panel-1', 'panel-2']);
    // 编译产物冻结值 = 正负组合（执行预览）
    expect(compiledByPanelId['panel-1']!.positive).toBe(params.batch_items![0]!.prompt_override);
  });

  it('skipAnchor 显式放行（无锚档案时不带风格参考）', () => {
    const project = makeProject({ panelCount: 2 });
    const { params } = buildPanelSeriesTask(project, CTX, { skipAnchor: true });
    expect(params.count).toBe(2);
    expect(params.batch_items![0]!.source_images).toEqual(['/refs/tangyuan.png']);
  });

  it('全部分镜已定稿 → 拒绝空批量', () => {
    const project = makeProject({ anchor: true, finalizeAnchorPanel: true, panelCount: 1 });
    expect(() => buildPanelSeriesTask(project, CTX)).toThrow('全部分镜已定稿');
  });
});

describe('buildPanelRegenTask（Phase 9）', () => {
  it('V4.2.11 §F：默认（未开启暂停确认）无锚档案也允许单格重绘——一致性走角色参考图', () => {
    const project = makeProject();
    const build = buildPanelRegenTask(project, 'panel-1', CTX);
    expect(build.panelId).toBe('panel-1');
    // 无锚点 → 参考只有角色定妆照
    expect(build.params.batch_items![0]!.source_images).toEqual(['/refs/tangyuan.png']);
    expect(build.compiled.positive).not.toContain('画风一致性（强制）');
  });

  it('未知 / stale 格拒绝', () => {
    const project = makeProject({ anchor: true });
    expect(() => buildPanelRegenTask(project, 'ghost', CTX)).toThrow('分镜不存在');
  });

  it('batch-of-1 + panel_regen 标记 + 锚点图首源', () => {
    const project = makeProject({ anchor: true });
    const { params, panelId } = buildPanelRegenTask(project, 'panel-1', CTX);
    expect(panelId).toBe('panel-1');
    expect(params.count).toBe(1);
    expect(params.batch_items![0]!.source_images![0]).toBe('/comic/anchor.png');
    expect(params.execution_snapshot?.comic).toMatchObject({ kind: 'panel_regen', panelId: 'panel-1' });
    expect(params.task_plan_summary).toContain('重绘');
  });
});

describe('applyComicTaskResults（结果回写）', () => {
  it('非漫画任务 / 异项目任务：原样返回同一引用', () => {
    const project = makeProject();
    const plain = makeFakeTask({ marker: null });
    expect(applyComicTaskResults(project, plain, []).project).toBe(project);
    const foreign = makeFakeTask({ marker: { projectId: 'other', kind: 'panels' } });
    expect(applyComicTaskResults(project, foreign, []).project).toBe(project);
  });

  it('panels 任务：完成槽落图、失败槽标失败', () => {
    const project = makeProject();
    const task = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [
        { panelId: 'panel-0', status: 'completed', imageId: 'img-1' },
        { panelId: 'panel-1', status: 'failed', error: '上游 429 限流' },
      ],
    });
    const result = applyComicTaskResults(project, task, [makeImage('img-1', '/out/comic/img-1.png')]);
    expect(result.changed).toBe(true);
    expect(result.imagesApplied).toBe(1);
    expect(result.project.panels[0]!.generationStatus).toBe('completed');
    expect(result.project.panels[0]!.imageAsset).toMatchObject({ path: '/out/comic/img-1.png', imageId: 'img-1', taskId: 'task-x' });
    expect(result.project.panels[1]!.generationStatus).toBe('failed');
    // §45 失败原因随回写落到面板
    expect(result.project.panels[1]!.lastError).toBe('上游 429 限流');
    // 对白层零触碰
    expect(result.project.dialogues).toBe(project.dialogues);
  });

  it('失败后重试成功：lastError 清除（卡片不再显示旧失败原因）', () => {
    const project = makeProject();
    const failed = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-1', status: 'failed', error: '超时' }],
    });
    const failedResult = applyComicTaskResults(project, failed, []);
    expect(failedResult.project.panels[1]!.lastError).toBe('超时');
    const recovered = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-1', status: 'completed', imageId: 'img-2' }],
    });
    const recoveredResult = applyComicTaskResults(failedResult.project, recovered, [makeImage('img-2', '/out/comic/img-2.png')]);
    expect(recoveredResult.project.panels[1]!.generationStatus).toBe('completed');
    expect(recoveredResult.project.panels[1]!.lastError).toBeUndefined();
  });

  it('幂等：重复回写返回原引用且不重复计数', () => {
    const project = makeProject();
    const task = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-0', status: 'completed', imageId: 'img-1' }],
    });
    const images = [makeImage('img-1', '/out/comic/img-1.png')];
    const once = applyComicTaskResults(project, task, images);
    const twice = applyComicTaskResults(once.project, task, images);
    expect(twice.project).toBe(once.project);
    expect(twice.imagesApplied).toBe(0);
  });

  it('重绘换图：regeneratedCount 递增', () => {
    const project = makeProject({
      anchor: true,
      finalizeAnchorPanel: true,
      panelCount: 2,
    });
    // panel-1 已有旧图，新任务换新图
    const seeded = {
      ...project,
      panels: project.panels.map(panel => panel.id === 'panel-1'
        ? { ...panel, imageAsset: { path: '/old.png', imageId: 'img-old', taskId: 'task-old' }, generationStatus: 'completed' as const }
        : panel),
    };
    const task = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panel_regen', panelId: 'panel-1' },
      slots: [{ panelId: 'panel-1', status: 'completed', imageId: 'img-new' }],
    });
    const result = applyComicTaskResults(seeded, task, [makeImage('img-new', '/out/comic/img-new.png')]);
    const panel = result.project.panels.find(item => item.id === 'panel-1')!;
    expect(panel.imageAsset!.imageId).toBe('img-new');
    expect(panel.regeneratedCount).toBe(1);
  });

  it('stale 格永不接收结果', () => {
    const project = makeProject({ staleFirst: true });
    const task = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-0', status: 'completed', imageId: 'img-1' }],
    });
    const result = applyComicTaskResults(project, task, [makeImage('img-1', '/x.png')]);
    expect(result.project).toBe(project);
  });

  it('完成但图库记录未扫到：不落图（留待下次刷新）', () => {
    const project = makeProject();
    const task = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-0', status: 'completed', imageId: 'img-1' }],
    });
    const result = applyComicTaskResults(project, task, []);
    expect(result.project).toBe(project);
  });
});

describe('buildAnchorConfirmation + lockAnchor（锚点审定冻结）', () => {
  it('完成锚点任务 → 载荷 → lockAnchor 写入一致性档案', () => {
    const project = makeProject();
    const task = makeFakeTask({
      id: 'task-anchor',
      marker: { projectId: 'p1', kind: 'anchor', panelId: 'panel-0' },
      slots: [{ panelId: 'panel-0', status: 'completed', imageId: 'img-a' }],
    });
    const images = [makeImage('img-a', '/comic/anchor.png')];
    const confirmation = buildAnchorConfirmation(project, task, images);
    expect(confirmation).toMatchObject({ panelId: 'panel-0', path: '/comic/anchor.png', imageId: 'img-a', taskId: 'task-anchor' });
    expect(confirmation!.lockedAt).not.toBe('');
    const locked = lockAnchor(project, confirmation!);
    expect(locked.consistency?.anchor).toEqual(confirmation);
    // 锁定后系列任务可发（门禁放行）
    const series = buildPanelSeriesTask(locked, CTX);
    expect(series.params.count).toBe(2);
  });

  it('未完成 / 非 anchor 任务 → null', () => {
    const project = makeProject();
    const failed = makeFakeTask({
      marker: { projectId: 'p1', kind: 'anchor', panelId: 'panel-0' },
      slots: [{ panelId: 'panel-0', status: 'failed' }],
    });
    expect(buildAnchorConfirmation(project, failed, [])).toBeNull();
    const panels = makeFakeTask({
      marker: { projectId: 'p1', kind: 'panels' },
      slots: [{ panelId: 'panel-0', status: 'completed', imageId: 'img-a' }],
    });
    expect(buildAnchorConfirmation(project, panels, [makeImage('img-a', '/x.png')])).toBeNull();
  });
});

describe('freezeCompiledPrompt', () => {
  it('冻结值含负面段（执行预览同构）', () => {
    const project = makeProject();
    const { compiled } = buildAnchorTask(project, CTX);
    const frozen = freezeCompiledPrompt(compiled);
    expect(frozen).toContain(compiled.positive);
    expect(frozen).toContain('画面中严格避免出现以下内容');
  });
});
