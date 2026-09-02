/**
 * AI 漫画 Phase 1.1 验收测试（§四~§十三/§十八/§十九）：
 *  - §四/§五/§八 状态机：confirmed 不放行（必选必须 locked + 参考图）、
 *    锁定缺参考图拦截（统一提示文案）、optional 槽位不阻塞；
 *  - §六/§七 角色参考图任务：buildCharacterReferenceTask（batch-of-1、character_ref
 *    溯源标记、角色不在项目拦截）+ applyComicTaskResults 回写（幂等 / 失败不写 / panels 不动）；
 *  - §九 Brief 修改 → referenceStale；
 *  - §十 Step Gate：story 步骤 enterable 由角色收口派生，blockedReasons 逐条给出；
 *  - §十一 comicCharactersSummaryState 单一事实源（empty/draft/ref 任务派生态/ready/locked 全矩阵）；
 *  - §十三 Progress Honesty：阶段百分比映射（failed 无条、retrying 回落）；
 *  - §十九 用户流集成：创建 → 绑定草稿角色 → 参考图任务完成 → 锁定 → optional 跳过 → story 可进。
 */

import { describe, it, expect } from 'vitest';
import type { ImageRecord, Task } from '../../../types';
import {
  applyComicCharacterPatches,
  attachCharacterReference,
  comicCharacterConfirmationState,
  comicCharactersSummaryState,
  COMIC_CHARACTER_LOCK_MISSING_REFERENCE,
  confirmComicCharacter,
  lockComicCharacter,
  type ComicReferenceTaskState,
} from '../domain';
import { buildCharacterReferenceTask } from '../comicTask';
import { applyComicTaskResults } from '../generation';
import { getComicStudioFlow } from '../comicStudioFlow';
import {
  comicPlannerElapsedSeconds,
  comicPlannerProgressTone,
  isComicPlannerRunning,
} from '../comicPlannerProgress';
import { normalizeComicCharacter, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicCharacter, ComicProject } from '../types';

// ---------------------------------------------------------------------------
// fixtures（hero 必选 + reporter 选配：锁死「optional 不得阻塞」）
// ---------------------------------------------------------------------------

function makeSkill() {
  return normalizeComicSkill({
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线，低饱和暖色',
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true, displayRule: '全身出场' },
      { slotId: 'reporter', name: '记者', required: false, displayRule: '仅手部' },
    ],
  })!;
}

function makeCharacter(overrides: Record<string, unknown> = {}): ComicCharacter {
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    immutableTraits: ['黄白毛色', '圆脸'],
    ...overrides,
  });
  expect(character).not.toBeNull();
  return character as ComicCharacter;
}

function makeProject(options: {
  characters?: ComicCharacter[];
  bindings?: Record<string, string>;
  story?: boolean;
} = {}): ComicProject {
  const characters = options.characters ?? [
    makeCharacter({ status: 'locked', referenceImage: { path: '/refs/char-1.png', label: '定妆照' } }),
  ];
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: 'character_confirmation',
    skillSnapshot: makeSkill(),
    characterSnapshots: characters,
    characterBindings: options.bindings ?? { hero: characters[0]!.id },
    panels: [],
    dialogues: [],
    story: options.story === false
      ? undefined
      : { title: '周一例会', topic: '例会', summary: '又延期', characterIds: [characters[0]!.id], beats: ['a', 'b'], endingType: 'twist', panelCount: 2 },
  })!;
}

// ---------------------------------------------------------------------------
// §四/§五/§八：状态机与锁定门禁
// ---------------------------------------------------------------------------

describe('Phase 1.1 §四/§五/§八 角色状态机', () => {
  it('confirmed 不放行：必选角色必须 locked（旧 confirmed 语义被门禁拦下）', () => {
    const project = makeProject({
      characters: [makeCharacter({ status: 'confirmed', referenceImage: { path: '/r.png', label: 'r' } })],
    });
    const state = comicCharacterConfirmationState(project);
    expect(state.ready).toBe(false);
    expect(state.blockers).toEqual(['角色「汤圆」已确认未锁定']);
  });

  it('locked + 参考图 → ready', () => {
    const project = makeProject();
    expect(comicCharacterConfirmationState(project).ready).toBe(true);
  });

  it('锁定缺参考图：domain 抛统一文案（§5.3 原文）', () => {
    expect(() => lockComicCharacter(makeCharacter(), { requireReference: true }))
      .toThrow(COMIC_CHARACTER_LOCK_MISSING_REFERENCE);
    expect(COMIC_CHARACTER_LOCK_MISSING_REFERENCE).toBe('请先生成或选择一张角色参考图');
  });

  it('有参考图锁定成功；不带 requireReference 保持旧调用兼容', () => {
    const withRef = attachCharacterReference(makeCharacter(), { path: '/r.png', label: '定妆' });
    expect(lockComicCharacter(withRef, { requireReference: true }).status).toBe('locked');
    expect(lockComicCharacter(makeCharacter()).status).toBe('locked');
  });

  it('optional 槽位空缺不阻塞（锁死 §10.3：选配不参与门禁）', () => {
    const project = makeProject(); // reporter 槽未绑定
    expect(comicCharacterConfirmationState(project).ready).toBe(true);

    const summary = comicCharactersSummaryState(project);
    expect(summary.slots.find(slot => slot.slotId === 'reporter')?.blocker).toBeNull();
    expect(summary.charactersDone).toBe(true);
    expect(summary.summaryLabel).toContain('选配 1 槽');
  });

  it('必选槽空缺给出绑定提示', () => {
    const project = makeProject({ bindings: {} });
    const state = comicCharacterConfirmationState(project);
    expect(state.ready).toBe(false);
    expect(state.blockers).toEqual(['角色「主角」未绑定']);
  });
});

// ---------------------------------------------------------------------------
// §六/§七：角色参考图任务构建与回写（复用既有 Image2 链路，零平行系统）
// ---------------------------------------------------------------------------

const REF_CTX = { outputDir: '/out/comic' };

describe('Phase 1.1 §六/§七 角色参考图任务', () => {
  it('角色不在项目内 → 拦截（提示先绑定槽位）', () => {
    const project = makeProject();
    const outsider = makeCharacter({ id: 'char-out', name: '路人' });
    expect(() => buildCharacterReferenceTask(project, outsider, REF_CTX))
      .toThrow('角色不在本项目内，请先在角色步骤绑定槽位');
  });

  it('batch-of-1 文生图任务 + character_ref 溯源标记（角色 id / 名字）', () => {
    const project = makeProject();
    const character = project.characterSnapshots[0]!;
    const { params, characterId, compiled } = buildCharacterReferenceTask(project, character, REF_CTX);
    expect(characterId).toBe(character.id);
    expect(params.batch_items ?? []).toHaveLength(1);
    expect(params.batch_items![0]!.variables).toMatchObject({ characterId: character.id });
    expect(params.task_source).toBe('comic');
    const marker = params.execution_snapshot?.comic;
    expect(marker).toMatchObject({ kind: 'character_ref', projectId: project.id, characterId: character.id, characterName: character.name });
    // 编译产物冻结：单角色定妆语义 + 无字底图铁律（§6.4）；无源图（references 空）
    expect(compiled.positive).toContain('角色参考图');
    expect(compiled.positive).toContain('画面中只有这一个角色');
    expect(compiled.negative).toContain('水印');
    expect(compiled.negative).toContain('第二个角色');
    expect(compiled.references).toEqual([]);
  });

  it('completed + 图库可解析 → 写入 referenceImage 并清 stale；panels 永不触碰', () => {
    const character = makeCharacter({ status: 'confirmed', referenceStale: true });
    const project = makeProject({ characters: [character] });
    const task = makeRefTask({ status: 'completed', imageId: 'img-ref-1' });
    const images: ImageRecord[] = [makeImage('img-ref-1', '/refs/new.png')];

    const result = applyComicTaskResults(project, task, images);
    expect(result.changed).toBe(true);
    expect(result.imagesApplied).toBe(1);
    const updated = result.project.characterSnapshots[0]!;
    expect(updated.referenceImage).toMatchObject({ path: '/refs/new.png', imageId: 'img-ref-1', taskId: 'task-ref-1' });
    expect(updated.referenceStale).toBeUndefined();
    expect(updated.referenceImage!.generatedAt).toBeTruthy();
    expect(result.project.panels).toEqual(project.panels);
  });

  it('幂等：同 imageId 二次回写不再变更（结构共享）', () => {
    const character = makeCharacter({ status: 'confirmed' });
    const project = makeProject({ characters: [character] });
    const task = makeRefTask({ status: 'completed', imageId: 'img-ref-1' });
    const images = [makeImage('img-ref-1', '/refs/new.png')];
    const once = applyComicTaskResults(project, task, images);
    const twice = applyComicTaskResults(once.project, task, images);
    expect(twice.changed).toBe(false);
    expect(twice.project).toBe(once.project);
  });

  it('在途 / 失败任务不改项目（状态由任务事实派生，§7.4）', () => {
    const project = makeProject();
    for (const status of ['queued', 'running', 'failed'] as const) {
      const result = applyComicTaskResults(project, makeRefTask({ status }), []);
      expect(result.changed).toBe(false);
      expect(result.project).toBe(project);
    }
  });

  it('marker 无 characterId 时回退读 batch_items[0].variables', () => {
    const character = makeCharacter({ status: 'confirmed' });
    const project = makeProject({ characters: [character] });
    const task = makeRefTask({ status: 'completed', imageId: 'img-x', dropMarkerCharacterId: true });
    const result = applyComicTaskResults(project, task, [makeImage('img-x', '/refs/x.png')]);
    expect(result.changed).toBe(true);
    expect(result.project.characterSnapshots[0]!.referenceImage?.imageId).toBe('img-x');
  });
});

function makeRefTask(options: {
  status: 'queued' | 'running' | 'completed' | 'failed';
  imageId?: string;
  dropMarkerCharacterId?: boolean;
  id?: string;
}): Task {
  const id = options.id ?? 'task-ref-1';
  const characterId = 'char-1';
  return {
    id,
    prompt: 'p',
    negative_prompt: 'n',
    task_source: 'comic',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    count: 1,
    status: options.status === 'completed' ? 'completed' : options.status === 'failed' ? 'failed' : 'running',
    created_at: '2026-08-30T03:00:00.000Z',
    output_dir: '/out/comic',
    success_count: options.status === 'completed' ? 1 : 0,
    failed_count: options.status === 'failed' ? 1 : 0,
    sub_tasks: [{ index: 0, status: options.status, ...(options.imageId ? { image_id: options.imageId } : {}) }],
    task_type: 'generate',
    source_images: [],
    batch_items: [{ id: `charref-${characterId}`, label: '角色「汤圆」', prompt_delta: '', variables: { characterId } }],
    execution_snapshot: {
      schemaVersion: 1,
      userRequirement: '角色定妆',
      positivePrompt: 'p',
      negativePrompt: 'n',
      comic: {
        kind: 'character_ref',
        projectId: 'p1',
        projectName: '第一期',
        skillName: '职场吐槽四格',
        ...(options.dropMarkerCharacterId ? {} : { characterId, characterName: '汤圆' }),
      },
    },
  } as unknown as Task;
}

function makeImage(id: string, path: string): ImageRecord {
  return {
    id,
    file_name: `${id}.png`,
    local_path: path,
    source_kind: 'image_gen',
    created_at: '2026-08-30T03:01:00.000Z',
    width: 1024,
    height: 1024,
  } as unknown as ImageRecord;
}

// ---------------------------------------------------------------------------
// §九：Brief 修改 → 参考图过期
// ---------------------------------------------------------------------------

describe('Phase 1.1 §九 参考图过期', () => {
  it('有参考图的角色改 Brief → referenceStale=true；换新图时清除', () => {
    const withRef = attachCharacterReference(
      makeCharacter({ status: 'confirmed' }),
      { path: '/r.png', label: '定妆', imageId: 'img-0', taskId: 'task-0' },
    );
    const patched = applyComicCharacterPatches(withRef, [{ field: 'appearance', value: '灰白毛色' }]);
    expect(patched.applied).toEqual(['appearance']);
    expect(patched.character.referenceStale).toBe(true);

    const refreshed = attachCharacterReference(patched.character, {
      path: '/r2.png', label: '新定妆', imageId: 'img-1', taskId: 'task-1', generatedAt: '2026-08-30T04:00:00.000Z',
    });
    expect(refreshed.referenceStale).toBeUndefined();
  });

  it('未命中修改 / 无参考图角色 → 不标过期', () => {
    const withRef = attachCharacterReference(makeCharacter(), { path: '/r.png', label: 'r' });
    const noop = applyComicCharacterPatches(withRef, []);
    expect(noop.character.referenceStale).toBeUndefined();

    const noRef = applyComicCharacterPatches(makeCharacter(), [{ field: 'appearance', value: '黑猫' }]);
    expect(noRef.character.referenceStale).toBeUndefined();
  });

  it('stale 角色：summary 标 ref_stale，门禁给出重新生成指引', () => {
    const character = applyComicCharacterPatches(
      attachCharacterReference(makeCharacter({ status: 'confirmed' }), { path: '/r.png', label: 'r' }),
      [{ field: 'appearance', value: '灰白毛色' }],
    ).character;
    const project = makeProject({ characters: [character] });
    const view = comicCharactersSummaryState(project).slots.find(slot => slot.slotId === 'hero');
    expect(view?.state).toBe('ref_stale');
    expect(view?.blocker).toContain('请重新生成参考图');
    expect(comicCharacterConfirmationState(project).ready).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §十：Step Gate（story 步骤门禁 = 角色收口；blockedReasons 逐条）
// ---------------------------------------------------------------------------

describe('Phase 1.1 §十 Step Gate（Phase 1.2 起 story 为第一步）', () => {
  it('角色未收口：story 恒可进（Step 1 无前置），characters 门禁逐条列出缺什么', () => {
    const project = makeProject({
      characters: [makeCharacter({ status: 'draft' })],
      bindings: { hero: 'char-1' },
      story: false,
    });
    const flow = getComicStudioFlow(project);
    const story = flow.steps.find(step => step.id === 'story')!;
    expect(story.enterable).toBe(true);
    expect(story.blockedReasons).toEqual([]);
    const characters = flow.steps.find(step => step.id === 'characters')!;
    expect(characters.enterable).toBe(false);
    // blockedReasons 给第一个未完成前置（story 未确认）；角色缺口在 blockers 上逐条可读
    expect(characters.blockedReasons).toEqual(['本期故事尚未确认']);
    expect(characters.blockers).toEqual(['角色「汤圆」尚未确认锁定']);
  });

  it('必选角色 locked + 参考图齐备（optional 空缺）→ story 可进', () => {
    const flow = getComicStudioFlow(makeProject());
    const story = flow.steps.find(step => step.id === 'story')!;
    expect(story.enterable).toBe(true);
    expect(story.blockedReasons).toEqual([]);
  });

  it('后续步骤门禁依次给出第一步缺口（story → skill → characters → storyboard → generate）', () => {
    const project = makeProject({
      characters: [makeCharacter({ status: 'confirmed', referenceImage: { path: '/r.png', label: 'r' } })],
      story: false,
    });
    project.panels = [];
    const flow = getComicStudioFlow(project);
    expect(flow.steps.find(step => step.id === 'generate')!.blockedReasons)
      .toEqual(['本期故事尚未确认']);
    expect(flow.steps.find(step => step.id === 'storyboard')!.enterable).toBe(false);
  });

  it('角色未锁但故事已确认：generate 门禁给到角色缺口（第一未完成前置）', () => {
    const project = makeProject({
      characters: [makeCharacter({ status: 'confirmed', referenceImage: { path: '/r.png', label: 'r' } })],
    });
    const flow = getComicStudioFlow(project);
    expect(flow.steps.find(step => step.id === 'generate')!.blockedReasons)
      .toEqual(['角色「汤圆」已确认未锁定']);
    expect(flow.steps.find(step => step.id === 'storyboard')!.enterable).toBe(false);
  });

  it('已确认角色经 confirm→lock 语义链：confirmed 放行前必须走 lock', () => {
    const confirmed = confirmComicCharacter(makeCharacter());
    const project = makeProject({
      characters: [{ ...confirmed, referenceImage: { path: '/r.png', label: 'r' } }],
    });
    expect(comicCharacterConfirmationState(project).ready).toBe(false);
    const locked = lockComicCharacter(
      attachCharacterReference(confirmed, { path: '/r.png', label: 'r' }),
      { requireReference: true },
    );
    const lockedProject = makeProject({ characters: [locked] });
    expect(comicCharacterConfirmationState(lockedProject).ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §十一：comicCharactersSummaryState 单一事实源（状态全矩阵）
// ---------------------------------------------------------------------------

describe('Phase 1.1 §十一 槽位状态矩阵', () => {
  const cases: Array<{
    name: string;
    character?: ComicCharacter;
    bindings?: Record<string, string>;
    referenceTask?: ComicReferenceTaskState;
    expectState: string;
    expectLabel: string;
    expectBlockerContains?: string;
  }> = [
    { name: '空槽', expectState: 'empty', expectLabel: '未绑定', expectBlockerContains: '未绑定' },
    {
      name: '草稿（有 Brief 无参考图）',
      character: makeCharacter({ status: 'draft' }),
      // V4.2.10 §七：徽标词表统一 —— 草稿态显示「待生成参考图」
      expectState: 'draft', expectLabel: '待生成参考图', expectBlockerContains: '未生成参考图',
    },
    {
      name: '参考图排队中（任务事实派生）',
      character: makeCharacter({ status: 'draft' }),
      referenceTask: { taskId: 't1', status: 'queued' },
      // V4.2.10 §七：排队并入「参考图生成中」徽标，blocker 保留排队事实
      expectState: 'ref_queued', expectLabel: '参考图生成中', expectBlockerContains: '参考图排队中',
    },
    {
      name: '参考图生成中',
      character: makeCharacter({ status: 'draft' }),
      referenceTask: { taskId: 't1', status: 'running' },
      expectState: 'ref_running', expectLabel: '参考图生成中', expectBlockerContains: '参考图生成中',
    },
    {
      name: '参考图失败且无旧图',
      character: makeCharacter({ status: 'draft' }),
      referenceTask: { taskId: 't1', status: 'failed' },
      expectState: 'ref_failed', expectLabel: '参考图生成失败', expectBlockerContains: '请重试',
    },
    {
      name: '参考图就绪待确认锁定',
      character: makeCharacter({ status: 'draft', referenceImage: { path: '/r.png', label: 'r' } }),
      // V4.2.10 §七：就绪/已确认统一显示「待确认」
      expectState: 'ready', expectLabel: '待确认', expectBlockerContains: '待确认锁定',
    },
    {
      name: '已确认未锁定（旧语义兼容）',
      character: makeCharacter({ status: 'confirmed', referenceImage: { path: '/r.png', label: 'r' } }),
      expectState: 'confirmed', expectLabel: '待确认', expectBlockerContains: '待锁定',
    },
    {
      name: '已锁定',
      character: makeCharacter({ status: 'locked', referenceImage: { path: '/r.png', label: 'r' } }),
      expectState: 'locked', expectLabel: '已锁定',
    },
    {
      name: '旧数据：锁定但缺参考图（修复指引）',
      character: makeCharacter({ status: 'locked' }),
      expectState: 'locked', expectLabel: '已锁定', expectBlockerContains: '缺少参考图',
    },
    {
      name: '失败但有旧图仍可用（回退 ready/confirmed 语义）',
      character: makeCharacter({ status: 'confirmed', referenceImage: { path: '/r.png', label: 'r' } }),
      referenceTask: { taskId: 't1', status: 'failed' },
      expectState: 'confirmed', expectLabel: '待确认', expectBlockerContains: '待锁定',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} → ${testCase.expectState}`, () => {
      const characters = testCase.character ? [testCase.character] : [];
      const project = makeProject({
        characters: characters.length > 0 ? characters : [makeCharacter({ status: 'locked', referenceImage: { path: '/keep.png', label: 'k' } })],
        bindings: testCase.character ? { hero: testCase.character.id } : {},
      });
      const referenceTasks = testCase.character
        ? (testCase.referenceTask ? { [testCase.character.id]: testCase.referenceTask } : {})
        : {};
      const summary = comicCharactersSummaryState(project, referenceTasks);
      const hero = summary.slots.find(slot => slot.slotId === 'hero')!;
      if (testCase.character) {
        expect(hero.state).toBe(testCase.expectState);
        expect(hero.label).toBe(testCase.expectLabel);
        if (testCase.expectBlockerContains) {
          expect(hero.blocker).toContain(testCase.expectBlockerContains);
        } else {
          expect(hero.blocker).toBeNull();
        }
      } else {
        // 空必选槽：state=empty + 绑定提示
        expect(hero.state).toBe('empty');
        expect(hero.blocker).toContain('未绑定');
      }
    });
  }

  it('汇总行文案：进行中列待办数，收口后列选配（§11.4）', () => {
    const draftProject = makeProject({ characters: [makeCharacter({ status: 'draft' })] });
    expect(comicCharactersSummaryState(draftProject).summaryLabel)
      .toBe('必选 0/1 已锁定 · 待办 1 项');

    const doneProject = makeProject();
    const summary = comicCharactersSummaryState(doneProject);
    expect(summary.requiredLocked).toBe(1);
    expect(summary.referenceReady).toBe(1);
    expect(summary.summaryLabel).toBe('必选 1/1 已锁定 · 选配 1 槽');
  });
});

// ---------------------------------------------------------------------------
// §十三：Progress Honesty（V4.2.9：阶段锚点百分比整体移除，等待感 =
// 阶段清单 ✓/●/○ + 真实计时；规划是单次 LLM 调用，无 token 级进度）
// ---------------------------------------------------------------------------

describe('Phase 1.1 §十三 进度诚实', () => {
  it('failed / idle 为非运行态（失败态不渲染 spinner / 阶段清单）', () => {
    expect(isComicPlannerRunning('failed')).toBe(false);
    expect(isComicPlannerRunning('idle')).toBe(false);
  });

  it('running 判定只含四个真实阶段', () => {
    expect(isComicPlannerRunning('resolving')).toBe(true);
    expect(isComicPlannerRunning('planning')).toBe(true);
    expect(isComicPlannerRunning('validating')).toBe(true);
    expect(isComicPlannerRunning('retrying')).toBe(true);
    expect(isComicPlannerRunning('idle')).toBe(false);
    expect(isComicPlannerRunning('completed')).toBe(false);
    expect(isComicPlannerRunning('failed')).toBe(false);
  });

  it('计时按秒递增；tone 三态（running / completed / failed → 卡片配色来源）', () => {
    expect(comicPlannerElapsedSeconds(1_000, 61_500)).toBe(60);
    expect(comicPlannerProgressTone('failed')).toBe('failed');
    expect(comicPlannerProgressTone('completed')).toBe('completed');
    expect(comicPlannerProgressTone('planning')).toBe('running');
    expect(comicPlannerProgressTone('resolving')).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// §十九：用户流集成（domain 级全链）——创建 → 草稿 → 参考图落图 → 锁定 → optional 跳过 → story 可进
// ---------------------------------------------------------------------------

describe('Phase 1.1 §十九 用户流集成', () => {
  it('创建项目（绑定草稿角色）→ 参考图任务完成回写 → 确认锁定 → story 可进', () => {
    // 1. 创建：AI 起草的草稿角色绑进必选槽（选配槽留空 = 跳过）
    let project = makeProject({
      characters: [makeCharacter({ status: 'draft' })],
      bindings: { hero: 'char-1' },
      story: false,
    });
    expect(comicCharacterConfirmationState(project).ready).toBe(false);

    // 2. 生成角色参考图：任务 completed → 回写定妆图
    const task = makeRefTask({ status: 'completed', imageId: 'img-flow' });
    const applied = applyComicTaskResults(project, task, [makeImage('img-flow', '/refs/flow.png')]);
    expect(applied.changed).toBe(true);
    project = applied.project;

    // 3. 参考图就绪 → 确认并锁定
    let ready = comicCharactersSummaryState(project);
    expect(ready.slots.find(slot => slot.slotId === 'hero')!.state).toBe('ready');
    const character = project.characterSnapshots[0]!;
    const locked = lockComicCharacter(character, { requireReference: true });
    project = {
      ...project,
      characterSnapshots: project.characterSnapshots.map(item => (item.id === locked.id ? locked : item)),
    };

    // 4. 角色收口（optional 空缺不阻塞）→ 分镜草稿门禁只差故事（Phase 1.2：story 是 Step 1）
    ready = comicCharactersSummaryState(project);
    expect(ready.charactersDone).toBe(true);
    expect(ready.summaryLabel).toBe('必选 1/1 已锁定 · 选配 1 槽');
    const flow = getComicStudioFlow(project);
    expect(flow.steps.find(step => step.id === 'story')!.enterable).toBe(true);
    expect(flow.steps.find(step => step.id === 'storyboard')!.blockedReasons).toEqual(['本期故事尚未确认']);
  });
});
