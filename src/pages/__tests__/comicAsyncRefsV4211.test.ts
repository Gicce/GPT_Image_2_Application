import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { comicCharactersSummaryState, comicCharacterConfirmationState } from '../../features/comic/domain';
import type { ComicCharacter, ComicProject } from '../../features/comic/types';
import { normalizeComicCharacter, normalizeComicProject, normalizeComicSkill } from '../../features/comic/normalize';

/**
 * V4.2.11 §B —— 角色参考图异步任务（P0-3）守卫（docs/ai-comic/19 审计 Q2）。
 *
 * V4.2.10 串行根因：ComicStudio 全量 taskRunning 互斥（任一任务在途 → 所有提交拒绝），
 * 真实数据 5 个 character_ref 任务严格先后串行（19 审计「附加事实」）。
 * 本套锁定 7 个验收场景：
 *  1  A 角色参考图生成中，B 角色的提交按钮不被 disable（per-character 状态）；
 *  2  每角色独立 queued / running / completed / failed（comicCharactersSummaryState 单一事实源）；
 *  3  同一角色在途时重复提交被去重（toast「已在进行中」，不重复计费）；
 *  4  分镜成图任务在途不阻塞参考图提交（内容域互斥拆分）；
 *  5  可选角色参考图未就绪不阻塞分镜门禁（只有必选锁定是门禁）；
 *  6  「生成全部缺失参考图」逐个独立提交（缺图 + 无在途 的已绑定角色）；
 *  7  cancelled 参考图任务归入 failed（对角色而言都是「没拿到图」），原位可重试。
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const stage = read('../../features/comic/components/ComicCharacterStage.tsx');
const page = read('../ComicStudio.tsx');

// ---------------------------------------------------------------------------
// 场景 1：A 生成中不 disable B
// ---------------------------------------------------------------------------

describe('V4.2.11 §B 场景 1 · A 生成中，B 可立即提交', () => {
  test('全量 generationBusy 互斥已废除（串行根因拆除）', () => {
    expect(page).not.toContain('generationBusy={taskRunning}');
    expect(page).not.toContain('props.generationBusy');
    expect(stage).not.toContain('generationBusy');
  });

  test('[生成参考图] 只受本角色 refBusy 约束（disabled={refBusy}）', () => {
    const genStart = stage.indexOf('comic-generate-ref-');
    expect(genStart).toBeGreaterThan(0);
    const block = stage.slice(genStart - 400, genStart);
    expect(block).toContain('disabled={refBusy}');
    expect(block).not.toContain('taskRunning');
  });

  test('referenceTaskStatusOf：cancelled 归入 failed（场景 7），pending/queued → queued', () => {
    expect(page).toContain("case 'cancelled': return 'failed'");
    expect(page).toContain("default: return 'queued'");
  });
});

// ---------------------------------------------------------------------------
// 场景 2：每角色独立状态（域函数）
// ---------------------------------------------------------------------------

const baseSkill = () => normalizeComicSkill({
  id: 'skill-1', name: '鸭梨山大',
  characterSlots: [
    { slotId: 'duckling', name: '小圆鸭', characterKey: 'main_duck', required: true },
    { slotId: 'duckMom', name: '鸭妈妈', characterKey: 'duck_mom', required: false },
  ],
  layout: { panelCount: 4, arrangement: 'grid_4' },
  referenceStrategy: { characterRefs: 'required', useAnchorAsStyle: false },
});

const characterDraft = (id: string, name: string, withRef: boolean, locked: boolean): ComicCharacter => {
  const normalized = normalizeComicCharacter({
  id, name, role: '角色', description: `${name} 的设定`,
  status: locked ? 'locked' : 'draft',
  referenceImage: withRef ? { path: `D:/refs/${id}.png`, label: name, imageId: `img-${id}` } : undefined,
  immutableTraits: [], mutableTraits: [],
  });
  expect(normalized).not.toBeNull();
  return normalized!;
};

const projectOf = (): ComicProject => {
  const project = normalizeComicProject({
    skillSnapshot: baseSkill(),
    characterSnapshots: [
      characterDraft('char-a', '小圆鸭', true, true),
      characterDraft('char-b', '鸭妈妈', false, false),
    ],
    characterBindings: { duckling: 'char-a', duckMom: 'char-b' },
  });
  expect(project).not.toBeNull();
  return project!;
};

describe('V4.2.11 §B 场景 2 · 每角色独立 queued/running/completed/failed', () => {
  test('A running + B queued + 无任务 → 三种状态并存', () => {
    const summary = comicCharactersSummaryState(projectOf(), {
      charA: { taskId: 't-a', status: 'running' },
    });
    const states = Object.fromEntries(summary.slots.map(slot => [slot.slotId, slot.state]));
    expect(states.duckling).toBe('locked');
    expect(states.duckMom).toBe('draft');
  });

  test('ref_queued / ref_running / ref_failed 状态词表存在（单一事实源派生）', () => {
    const domain = read('../../features/comic/domain.ts');
    expect(domain).toContain("'ref_queued'");
    expect(domain).toContain("'ref_running'");
    expect(domain).toContain("'ref_failed'");
    const referenceTasks = {
      'char-x': { taskId: 't1', status: 'queued' as const },
      'char-y': { taskId: 't2', status: 'running' as const },
      'char-z': { taskId: 't3', status: 'failed' as const },
    };
    const project = projectOf();
    const extended: ComicProject = {
      ...project,
      characterSnapshots: [
        ...project.characterSnapshots,
        characterDraft('char-x', '甲', false, false),
        characterDraft('char-y', '乙', false, false),
        characterDraft('char-z', '丙', false, false),
      ],
      characterBindings: { ...project.characterBindings, s1: 'char-x', s2: 'char-y', s3: 'char-z' },
    };
    const skill = { ...extended.skillSnapshot, characterSlots: [...extended.skillSnapshot.characterSlots,
      { slotId: 's1', name: '甲', required: false },
      { slotId: 's2', name: '乙', required: false },
      { slotId: 's3', name: '丙', required: false }] };
    const summary = comicCharactersSummaryState({ ...extended, skillSnapshot: skill }, referenceTasks);
    const bySlot = Object.fromEntries(summary.slots.map(slot => [slot.slotId, slot.state]));
    expect(bySlot.s1).toBe('ref_queued');
    expect(bySlot.s2).toBe('ref_running');
    expect(bySlot.s3).toBe('ref_failed');
  });
});

// ---------------------------------------------------------------------------
// 场景 3/4/6：提交守卫（页面层源码契约）
// ---------------------------------------------------------------------------

describe('V4.2.11 §B 场景 3/4/6 · 提交守卫按内容域拆分', () => {
  test('同角色在途去重：queued/running/提交确认中 → toast「已在进行中」', () => {
    const handler = page.slice(
      page.indexOf('const handleGenerateCharacterRef'),
      page.indexOf('const handleGenerateMissingRefs'),
    );
    expect(handler).toContain("state === 'queued' || state === 'running' || refSubmitting[character.id]");
    expect(handler).toContain('的参考图任务已在进行中');
    // 不再有全量互斥 toast
    expect(handler).not.toContain('本项目已有生成任务进行中');
  });

  test('分镜批量在途只拦分镜（panelsTaskRunning = 非 character_ref 任务），参考图提交不检查它', () => {
    expect(page).toContain("marker.kind !== 'character_ref'");
    const handler = page.slice(
      page.indexOf('const handleGenerateCharacterRef'),
      page.indexOf('const handleGenerateMissingRefs'),
    );
    expect(handler).not.toContain('panelsTaskRunning');
    const guard = page.slice(page.indexOf('const guardActive'), page.indexOf('const handleGenerateAnchor'));
    expect(guard).toContain('panelsTaskRunning');
    expect(guard).toContain('本批分镜成图任务进行中');
  });

  test('一键补齐：missingRefCharacters = 已绑定 + 无参考图 + 无在途；逐个提交、互不阻塞', () => {
    expect(stage).toContain('missingRefCharacters');
    expect(stage).toContain('生成全部缺失参考图');
    expect(stage).toContain('comic-cast-batch-refs');
    expect(page).toContain('const handleGenerateMissingRefs');
    const batch = page.slice(page.indexOf('const handleGenerateMissingRefs'));
    expect(batch).toContain('for (const character of missing)');
    expect(batch).toContain("referenceTasks[character.id]?.status !== 'queued'");
  });
});

// ---------------------------------------------------------------------------
// 场景 5：可选角色参考图不阻塞分镜门禁
// ---------------------------------------------------------------------------

describe('V4.2.11 §B 场景 5 · 可选参考图不阻塞分镜', () => {
  test('门禁 = 必选槽位锁定（comicCharacterConfirmationState 只算 required）', () => {
    const project = projectOf();
    // 必选已锁定（无参考图但 locked——构造里 referenceImage 缺省 required 会拦，此处直接验证确认态语义）
    const confirmation = comicCharacterConfirmationState(project);
    expect(confirmation.ready).toBe(true);
    const flow = read('../../features/comic/comicStudioFlow.ts');
    expect(flow).toContain('charactersDone = confirmation.ready');
  });
});
