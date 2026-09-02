/**
 * AI 漫画 Phase 1.2-J 集成测试（规格 §129 黄金路径 + §83 六组保持矩阵 + §84 重开恢复）。
 *
 * 级别：domain 级全链路串联（无组件挂载、无真实后端）——用真实领域函数把
 * 「小黄鸭成长漫画」从建项推到组页导出，任何一步断开即测试失败（§129 铁律：
 * 黄金路径断开 = 禁止宣布完成）。
 *
 * 覆盖：
 * - §129：故事 → 四宫格 2×2 → 萌系简笔 → 对白方式 → 角色锁定入库 → 分镜 4 格 →
 *   第一张（Anchor，单格 Prompt 铁律）→ 剩余 3 张（含 §46 部分失败 + 只重试失败格）→
 *   修改对白零生图 → 2×2 组页 → 关闭重开全恢复（§84）；
 * - §83：Story↔Presentation↔Character↔Storyboard↔Anchor↔Series↔Text 六组往返，
 *   已提交状态 + uiDraft 草稿在「落盘 → 重读 → normalize」模型下全部保持。
 */

import { describe, expect, test } from 'vitest';
import type { ImageRecord, Task } from '../../../types';
import {
  applyDialogueModeToProject,
  applyPresentationToProject,
  applyStoryOnlyToProject,
  applyStoryToProject,
  applyVisualStyleToProject,
  bindSlotCharacter,
  bumpComicCharacterUsage,
  comicCharacterFromLibrary,
  comicCharacterToLibraryEntry,
  lockAnchor,
  lockComicCharacter,
  upsertDialogue,
} from '../domain';
import { applyComicTaskResults, buildAnchorConfirmation } from '../generation';
import { buildAnchorTask, buildPanelRegenTask, buildPanelSeriesTask } from '../comicTask';
import { compilePanelPrompt } from '../promptCompiler';
import { comicPresentationTemplateOf, resolveComicPresentation } from '../presentation';
import { computePageLayouts } from '../comicExport';
import {
  normalizeComicCharacter,
  normalizeComicDialogue,
  normalizeComicPanel,
  normalizeComicProject,
  normalizeComicSkill,
} from '../normalize';
import type { ComicCharacter, ComicProject, ComicStory } from '../types';

const CTX = { outputDir: '/out/comic' };
const NOW = '2026-09-02T00:00:00.000Z';

/** 「落盘 → 重开」模型：data_json 序列化 → 读取 → normalize（openProject 同路径）。 */
function roundTrip(project: ComicProject): ComicProject {
  const restored = normalizeComicProject(JSON.parse(JSON.stringify(project)));
  expect(restored).not.toBeNull();
  return restored!;
}

function makeImage(id: string, path: string): ImageRecord {
  return { id, task_id: 't', local_path: path, file_name: `${id}.png`, created_at: NOW, status: 'transparent' };
}

interface FakeSlot { panelId: string; status: 'completed' | 'failed'; imageId?: string; error?: string }

function makeTask(
  id: string,
  marker: { projectId: string; kind: 'anchor' | 'panels' | 'panel_regen' | 'character_ref' } & Record<string, unknown>,
  slots: FakeSlot[],
  markerPanelId?: string,
): Task {
  return {
    id,
    prompt: 'p',
    negative_prompt: 'n',
    task_source: 'comic',
    size: '1024x1024',
    quality: 'auto',
    output_format: 'png',
    count: slots.length,
    status: slots.every(slot => slot.status === 'completed') ? 'completed' : 'failed',
    created_at: NOW,
    output_dir: CTX.outputDir,
    success_count: slots.filter(slot => slot.status === 'completed').length,
    failed_count: slots.filter(slot => slot.status === 'failed').length,
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
      label: slot.panelId,
      prompt_delta: '',
      variables: { panelId: slot.panelId },
    })),
    execution_snapshot: {
      schemaVersion: 1,
      userRequirement: '小黄鸭成长漫画',
      positivePrompt: 'p',
      negativePrompt: 'n',
      effectivePrompt: 'p',
      promptSource: 'comic-compiled',
      referenceImages: [],
      generationParams: {},
      createdAt: NOW,
      comic: markerPanelId ? { ...marker, panelId: markerPanelId } : marker,
    },
  } as unknown as Task;
}

function makeNarration(project: ComicProject, text: string): ComicProject['dialogues'][number] {
  const dialogue = normalizeComicDialogue({
    id: 'dlg-1',
    panelId: 'panel-0',
    speakerId: 'narrator',
    type: 'caption',
    text,
    position: { x: 0.5, y: 0.08 },
    alignment: 'center',
    fontStyle: { size: 18, weight: 500 },
    bubbleStyle: 'none',
  });
  expect(dialogue).not.toBeNull();
  return dialogue!;
}

// ---------------------------------------------------------------------------
// 黄金路径基建：小黄鸭《绒绒的第一跳》
// ---------------------------------------------------------------------------

const DUCK_STORY: ComicStory = {
  title: '绒绒的第一跳',
  topic: '小黄鸭成长漫画',
  summary: '小黄鸭第一次跳上木桩失败，最后决定继续尝试。',
  characterIds: ['char-duck'],
  beats: ['绒绒站在木桩下仰望', '第一次起跳摔进水里', '抖抖水珠再试一次', '决定继续尝试，笑了'],
  endingType: 'warm',
  panelCount: 4,
};

function makeBaseProject(): ComicProject {
  const skill = normalizeComicSkill({
    name: '萌系成长漫画',
    visualStyle: '简笔线条，低饱和暖色',
    layout: { arrangement: 'grid_4', panelCount: 4 },
    characterSlots: [{ slotId: 'hero', name: '主角', required: true, displayRule: '每格出场' }],
  });
  const duck = normalizeComicCharacter({
    id: 'char-duck',
    name: '绒绒',
    status: 'confirmed',
    appearance: '奶黄色小黄鸭，圆身体短翅膀',
    immutableTraits: ['奶黄羽毛', '橙色扁嘴'],
    referenceImage: { path: '/refs/duck.png', label: '绒绒定妆照', imageId: 'img-duck', taskId: 'task-ref' },
  }) as ComicCharacter;
  const project = normalizeComicProject({
    id: 'p-golden',
    name: '绒绒的第一跳',
    stage: 'draft',
    skillSnapshot: skill,
    characterSnapshots: [duck],
    characterBindings: {},
    panels: [],
    dialogues: [],
  });
  expect(project).not.toBeNull();
  return project!;
}

function makePanels(): ComicProject['panels'] {
  const scenes = ['木桩下的仰望', '第一次起跳落水', '抖水再试', '决定继续尝试'];
  return scenes.map((scene, order) => normalizeComicPanel({
    id: `panel-${order}`,
    order,
    scene,
    characterIds: ['char-duck'],
    shotType: '全景',
    camera: '平视',
    composition: '居中',
    characterActions: [`绒绒${order === 0 ? '仰望木桩' : '扑腾'}`],
    background: '池塘边',
  })!);
}

/** 黄金路径推进到「第一张已确认 + 剩余全部完成」的项目。 */
function buildGoldenProject(): ComicProject {
  // Step 1 确认故事（Phase 1.2 Step 1 只落故事，不带分镜）
  let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
  project = { ...project, stage: 'story_ready' };
  // Step 2 画面与形式：四宫格 + 萌系简笔 + 对白方式
  project = applyPresentationToProject(project, comicPresentationTemplateOf('grid_4')!).project;
  project = applyVisualStyleToProject(project, '萌系简笔，圆润线条，低饱和暖色');
  project = applyDialogueModeToProject(project, 'narration');
  // Step 3 角色演员：参考图已备 → 确认并锁定 + 绑主角槽
  const duck = project.characterSnapshots[0]!;
  const lockedDuck = lockComicCharacter(duck, { requireReference: true });
  project = bindSlotCharacter(project, 'hero', lockedDuck);
  // Step 4 分镜草稿：4 格，每格只有一个镜头描述
  project = applyStoryToProject(project, DUCK_STORY, makePanels(), []).project;
  project = { ...project, stage: 'generating_anchor' };
  // Step 5 第一张效果：生成 → 满意 → 确认（锁定 Anchor）
  const anchorRun = buildAnchorTask(project, CTX);
  const anchorTask = makeTask('task-anchor', { projectId: 'p-golden', kind: 'anchor' },
    [{ panelId: anchorRun.panelId, status: 'completed', imageId: 'img-anchor' }], anchorRun.panelId);
  const anchorImages = [makeImage('img-anchor', '/comic/anchor.png')];
  project = applyComicTaskResults(project, anchorTask, anchorImages).project;
  const confirmation = buildAnchorConfirmation(project, anchorTask, anchorImages);
  expect(confirmation).not.toBeNull();
  project = lockAnchor(project, confirmation!);
  project = { ...project, stage: 'generating_panels' };
  // Step 6 生成剩余图片：panel-2 失败（§46）→ 只重试失败格 → 全部完成
  const seriesTask = makeTask('task-series', { projectId: 'p-golden', kind: 'panels' }, [
    { panelId: 'panel-1', status: 'completed', imageId: 'img-1' },
    { panelId: 'panel-2', status: 'failed', error: '上游 429 限流' },
    { panelId: 'panel-3', status: 'completed', imageId: 'img-3' },
  ]);
  project = applyComicTaskResults(project, seriesTask, [
    makeImage('img-1', '/comic/img-1.png'),
    makeImage('img-3', '/comic/img-3.png'),
  ]).project;
  const retryTask = makeTask('task-retry', { projectId: 'p-golden', kind: 'panel_regen' },
    [{ panelId: 'panel-2', status: 'completed', imageId: 'img-2' }], 'panel-2');
  project = applyComicTaskResults(project, retryTask, [makeImage('img-2', '/comic/img-2.png')]).project;
  project = { ...project, stage: 'editing' };
  return project;
}

// ---------------------------------------------------------------------------
// §129 黄金路径
// ---------------------------------------------------------------------------

describe('§129 黄金路径：小黄鸭成长漫画全链路', () => {
  test('Step 1~2：确认故事 → 四宫格 2×2 → 萌系简笔 → 对白方式', () => {
    const base = makeBaseProject();
    const afterStory = applyStoryOnlyToProject(base, DUCK_STORY);
    expect(afterStory.project.story?.title).toBe('绒绒的第一跳');
    expect(afterStory.project.story?.panelCount).toBe(4);

    const afterPresentation = applyPresentationToProject(
      afterStory.project, comicPresentationTemplateOf('grid_4')!,
    );
    expect(afterPresentation.project.skillSnapshot.layout.arrangement).toBe('grid_4');
    // 屏幕真实看到：2×2 Layout Preview（§89 单点几何）
    const presentation = resolveComicPresentation(afterPresentation.project.skillSnapshot, { totalPanels: 4 });
    expect(presentation.columns).toBe(2);
    expect(presentation.pageCount).toBe(1);
    expect(presentation.pages[0]!.panelOrders).toEqual([0, 1, 2, 3]);

    const styled = applyVisualStyleToProject(afterPresentation.project, '萌系简笔，圆润线条，低饱和暖色');
    expect(styled.skillSnapshot.visualStyle).toBe('萌系简笔，圆润线条，低饱和暖色');
    const withMode = applyDialogueModeToProject(styled, 'narration');
    expect(withMode.skillSnapshot.textStyle.dialogueMode).toBe('narration');
  });

  test('Step 3：小黄鸭确认锁定 → 保存演员库 → 库里还能看到（引用即计数）', () => {
    const duck = makeBaseProject().characterSnapshots[0]!;
    const locked = lockComicCharacter(duck, { requireReference: true });
    expect(locked.status).toBe('locked');

    // ☑ 保存到演员库：条目保留参考图与特征（§19 只写库不回写项目）
    const entry = comicCharacterToLibraryEntry(locked);
    expect(entry.referenceImage?.imageId).toBe('img-duck');
    expect(entry.immutableTraits).toEqual(['奶黄羽毛', '橙色扁嘴']);
    // 「从演员库选择」能看到刚才的小黄鸭：引用即计数 + 复用为深拷贝快照
    const used = bumpComicCharacterUsage(entry, NOW);
    expect(used.usageCount).toBe(1);
    expect(used.lastUsedAt).toBe(NOW);
    const snapshot = comicCharacterFromLibrary(used);
    expect(snapshot.name).toBe('绒绒');
    expect(snapshot.referenceImage?.imageId).toBe('img-duck');
    expect(snapshot.usageCount).toBeUndefined();
  });

  test('Step 4~5：分镜 4 格（每格一个镜头描述）→ 第一张单格 Prompt 铁律 → 确认锁定', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    project = bindSlotCharacter(project, 'hero', project.characterSnapshots[0]!);
    project = applyStoryToProject(project, DUCK_STORY, makePanels(), []).project;

    // 每格只有一个镜头描述（§37：scene 即画面）
    expect(project.panels).toHaveLength(4);
    for (const panel of project.panels) {
      expect(panel.scene.length).toBeGreaterThan(0);
      expect(panel.stale).toBeFalsy();
    }

    // R1：第一张 Prompt 是单格画面，不含页面级「四格漫画」形式词
    const compiled = compilePanelPrompt({ project, panel: project.panels[0]!, mode: 'anchor' });
    expect(compiled.positive).toContain('【萌系成长漫画】');
    expect(compiled.positive).toContain('单格画面（强制）');
    expect(compiled.positive).not.toContain('四格漫画');
    expect(compiled.negative).toContain('多格拼图');

    const anchorRun = buildAnchorTask(project, CTX);
    expect(anchorRun.params.count).toBe(1);
    expect(anchorRun.panelId).toBe('panel-0');

    const anchorTask = makeTask('task-anchor', { projectId: 'p-golden', kind: 'anchor' },
      [{ panelId: 'panel-0', status: 'completed', imageId: 'img-anchor' }], 'panel-0');
    const images = [makeImage('img-anchor', '/comic/anchor.png')];
    const applied = applyComicTaskResults(project, anchorTask, images);
    expect(applied.project.panels[0]!.imageAsset?.imageId).toBe('img-anchor');
    const confirmation = buildAnchorConfirmation(applied.project, anchorTask, images);
    expect(confirmation).toMatchObject({ panelId: 'panel-0', imageId: 'img-anchor' });
    const locked = lockAnchor(applied.project, confirmation!);
    expect(locked.consistency?.anchor?.imageId).toBe('img-anchor');
  });

  test('Step 6 内部：Panel 2 失败 → 已成功 3 张不回退，失败格带原因，重试只打失败格', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    project = bindSlotCharacter(
      project, 'hero',
      lockComicCharacter(project.characterSnapshots[0]!, { requireReference: true }),
    );
    project = applyStoryToProject(project, DUCK_STORY, makePanels(), []).project;
    const anchorTask = makeTask('task-anchor', { projectId: 'p-golden', kind: 'anchor' },
      [{ panelId: 'panel-0', status: 'completed', imageId: 'img-anchor' }], 'panel-0');
    const images = [makeImage('img-anchor', '/comic/anchor.png')];
    project = applyComicTaskResults(project, anchorTask, images).project;
    project = lockAnchor(project, buildAnchorConfirmation(project, anchorTask, images)!);

    const seriesRun = buildPanelSeriesTask(project, CTX);
    expect(seriesRun.panelIds).toEqual(['panel-1', 'panel-2', 'panel-3']);
    const seriesTask = makeTask('task-series', { projectId: 'p-golden', kind: 'panels' }, [
      { panelId: 'panel-1', status: 'completed', imageId: 'img-1' },
      { panelId: 'panel-2', status: 'failed', error: '上游 429 限流' },
      { panelId: 'panel-3', status: 'completed', imageId: 'img-3' },
    ]);
    const result = applyComicTaskResults(project, seriesTask, [
      makeImage('img-1', '/comic/img-1.png'),
      makeImage('img-3', '/comic/img-3.png'),
    ]);
    expect(result.imagesApplied).toBe(2);
    const panels = result.project.panels;
    expect(panels[0]!.generationStatus).toBe('completed'); // anchor 不受影响
    expect(panels[1]!.generationStatus).toBe('completed');
    expect(panels[2]!.generationStatus).toBe('failed');
    expect(panels[2]!.lastError).toBe('上游 429 限流');
    expect(panels[3]!.generationStatus).toBe('completed');
    // §46：重试只打失败格（batch-of-1），成功格不重出
    const retry = buildPanelRegenTask(result.project, 'panel-2', CTX);
    expect(retry.params.count).toBe(1);
    expect(retry.panelId).toBe('panel-2');
  });

  test('Step 6 结果：任务结果 4 张 = 4 张独立单图，全部完成零失败残留', () => {
    const project = buildGoldenProject();
    const active = project.panels.filter(panel => !panel.stale);
    expect(active).toHaveLength(4);
    for (const panel of active) {
      expect(panel.generationStatus).toBe('completed');
      expect(panel.imageAsset).toBeTruthy();
      expect(panel.lastError).toBeUndefined();
    }
    // 每张 Panel = 单图（imageId 各自独立，不共享一张拼图）
    const imageIds = new Set(active.map(panel => panel.imageAsset!.imageId));
    expect(imageIds.size).toBe(4);
  });

  test('Step 7：修改对白 → Image2 不得重新执行（文字层零触碰生图输入）', () => {
    const project = buildGoldenProject();
    const withDialogue = upsertDialogue(project, makeNarration(project, '绒绒决定再试一次。'));
    const panelsBefore = JSON.stringify(withDialogue.panels);
    const compiledBefore = compilePanelPrompt({
      project: withDialogue, panel: withDialogue.panels[0]!, mode: 'series',
    }).positive;

    const afterEdit = upsertDialogue(withDialogue, makeNarration(withDialogue, '再试一次，不着急。'));
    expect(afterEdit.dialogues).toHaveLength(1);
    expect(afterEdit.dialogues[0]!.text).toBe('再试一次，不着急。');
    // 修改对白不改任何面板 / 编译产物（结构零变化 = 不会触发 Image2）
    expect(JSON.stringify(afterEdit.panels)).toBe(panelsBefore);
    const compiledAfter = compilePanelPrompt({
      project: afterEdit, panel: afterEdit.panels[0]!, mode: 'series',
    }).positive;
    expect(compiledAfter).toBe(compiledBefore);
  });

  test('§47：系统自动组合 2×2 完整四宫格（单页 4 槽，2 列 × 2 行）', () => {
    const project = buildGoldenProject();
    const pages = computePageLayouts(project);
    expect(pages).toHaveLength(1);
    const slots = pages[0]!.slots;
    expect(slots).toHaveLength(4);
    expect(slots.map(slot => slot.panelId)).toEqual(['panel-0', 'panel-1', 'panel-2', 'panel-3']);
    // 2×2 几何：2 个不同列坐标 × 2 个不同行坐标（columns 从槽位矩形派生）
    const xs = new Set(slots.map(slot => Math.round(slot.x)));
    const ys = new Set(slots.map(slot => Math.round(slot.y)));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
    expect(slots[0]!.y).toBe(slots[1]!.y); // 同一行
    expect(slots[2]!.y).toBeGreaterThan(slots[0]!.y); // 下一行
  });

  test('Step 8 + §84：保存 → 关闭 → 重新打开，七段全部恢复', () => {
    const project = buildGoldenProject();
    const withDialogue = upsertDialogue(project, makeNarration(project, '绒绒决定再试一次。'));
    const restored = roundTrip(withDialogue);
    // Story / Presentation
    expect(restored.story?.title).toBe('绒绒的第一跳');
    expect(restored.skillSnapshot.layout.arrangement).toBe('grid_4');
    expect(restored.skillSnapshot.visualStyle).toBe('萌系简笔，圆润线条，低饱和暖色');
    expect(restored.skillSnapshot.textStyle.dialogueMode).toBe('narration');
    // Character
    expect(restored.characterSnapshots[0]!.status).toBe('locked');
    expect(restored.characterSnapshots[0]!.referenceImage?.imageId).toBe('img-duck');
    expect(restored.characterBindings.hero).toBe('char-duck');
    // Storyboard + Series
    expect(restored.panels).toHaveLength(4);
    expect(restored.panels.every(panel => panel.generationStatus === 'completed' && panel.imageAsset)).toBe(true);
    // Anchor
    expect(restored.consistency?.anchor?.imageId).toBe('img-anchor');
    // Dialogue
    expect(restored.dialogues[0]!.text).toBe('绒绒决定再试一次。');
  });
});

// ---------------------------------------------------------------------------
// §83 六组 back/forward 保持矩阵（落盘 → 重读 → normalize 模型）
// ---------------------------------------------------------------------------

describe('§83 返回后状态还在（六组保持矩阵）', () => {
  test('1. Story → Presentation → Story：故事已确认 + 故事草稿保持', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    project = applyPresentationToProject(project, comicPresentationTemplateOf('grid_4')!).project;
    project = {
      ...project,
      uiDraft: {
        story: {
          requirement: '结尾再暖一点',
          // review 阶段 = 有待审定的故事草稿（normalize 设计：无草稿不保 phase）
          storyDraft: { ...DUCK_STORY, summary: '失败后决定每天练习，最后笑了。' },
          phase: 'review',
        },
      },
    };
    const back = roundTrip(project);
    expect(back.story?.title).toBe('绒绒的第一跳');
    expect(back.uiDraft?.story?.requirement).toBe('结尾再暖一点');
    expect(back.uiDraft?.story?.phase).toBe('review');
    expect(back.uiDraft?.story?.storyDraft?.summary).toBe('失败后决定每天练习，最后笑了。');
  });

  test('2. Presentation → Character → Presentation：四宫格仍选中（排版 / 风格 / 对白方式）', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    project = applyPresentationToProject(project, comicPresentationTemplateOf('grid_9')!).project;
    project = applyVisualStyleToProject(project, '萌系简笔，圆润线条，低饱和暖色');
    project = applyDialogueModeToProject(project, 'narration');
    const back = roundTrip(project);
    expect(back.skillSnapshot.layout.arrangement).toBe('grid_9');
    expect(resolveComicPresentation(back.skillSnapshot, { totalPanels: 9 }).columns).toBe(3);
    expect(back.skillSnapshot.visualStyle).toBe('萌系简笔，圆润线条，低饱和暖色');
    expect(back.skillSnapshot.textStyle.dialogueMode).toBe('narration');
  });

  test('3. Character → Storyboard → Character：Reference / locked 状态仍保持 + 微调草稿保持', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    const locked = lockComicCharacter(project.characterSnapshots[0]!, { requireReference: true });
    project = bindSlotCharacter(project, 'hero', locked);
    project = { ...project, uiDraft: { character: { patchTexts: { 'char-duck': '嘴再扁一点' } } } };
    const back = roundTrip(project);
    expect(back.characterSnapshots[0]!.status).toBe('locked');
    expect(back.characterSnapshots[0]!.referenceImage?.imageId).toBe('img-duck');
    expect(back.characterBindings.hero).toBe('char-duck');
    expect(back.uiDraft?.character?.patchTexts?.['char-duck']).toBe('嘴再扁一点');
  });

  test('4. Storyboard → Anchor → Storyboard：4 格分镜 + 单格微调草稿保持', () => {
    let project = applyStoryOnlyToProject(makeBaseProject(), DUCK_STORY).project;
    project = bindSlotCharacter(project, 'hero', project.characterSnapshots[0]!);
    project = applyStoryToProject(project, DUCK_STORY, makePanels(), []).project;
    project = {
      ...project,
      uiDraft: { storyboard: { patchTexts: { 'panel-1': '背景加一根木桩' } } },
    };
    const back = roundTrip(project);
    expect(back.panels.filter(panel => !panel.stale)).toHaveLength(4);
    expect(back.uiDraft?.storyboard?.patchTexts?.['panel-1']).toBe('背景加一根木桩');
  });

  test('5. Anchor → Series → Anchor：一致性档案 + 首格图保持', () => {
    const back = roundTrip(buildGoldenProject());
    expect(back.consistency?.anchor?.panelId).toBe('panel-0');
    expect(back.consistency?.anchor?.imageId).toBe('img-anchor');
    expect(back.panels.find(panel => panel.id === 'panel-0')!.imageAsset?.imageId).toBe('img-anchor');
  });

  test('6. Series → Text → Series：4/4 成图状态保持（回到 Series 不丢已生成事实）', () => {
    const project = { ...buildGoldenProject(), stage: 'editing' as const };
    const back = roundTrip(project);
    expect(back.panels.every(panel => panel.generationStatus === 'completed')).toBe(true);
    expect(back.panels.every(panel => Boolean(panel.imageAsset))).toBe(true);
  });
});
