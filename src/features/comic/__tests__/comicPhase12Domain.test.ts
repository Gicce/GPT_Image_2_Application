/**
 * AI 漫画 Phase 1.2 —— Workflow Domain 焦点测试：
 *  - presentation.ts：模板完整性 / resolveComicPresentation 排版 / 标签 / 模板补丁；
 *  - normalize：§70 旧项目 arrangement 确定性推导 + dialogueMode / pageCount 兼容；
 *  - comicStudioFlow：用户优先步骤序（story 第一）/ 门禁链 / 对白步骤 partial 放行；
 *  - applyStoryOnlyToProject：Step 1 只写 story，旧分镜 stale 化、幂等 no-op；
 *  - getComicProjectSummary / getStoryOverview：Rail 与 Hero Card 单一来源。
 */

import { describe, it, expect } from 'vitest';
import {
  COMIC_PRESENTATION_TEMPLATES,
  comicPresentationLabel,
  comicPresentationTemplateOf,
  presentationPatchFor,
  resolveComicPresentation,
} from '../presentation';
import {
  COMIC_STEP_TITLES,
  getComicProjectSummary,
  getComicStudioFlow,
  getStoryOverview,
} from '../comicStudioFlow';
import { applyStoryOnlyToProject } from '../domain';
import {
  applyDialogueModeToProject,
  applyPresentationToProject,
  applyVisualStyleToProject,
} from '../domain';
import { normalizeComicCharacter, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';
import type { ComicProject } from '../types';

function makeProject(options: {
  stage?: ComicProject['stage'];
  arrangement?: string;
  panelCount?: number;
  pageCount?: number;
  dialogueMode?: string;
  story?: boolean;
  completedPanels?: number;
  pendingPanels?: number;
  anchor?: boolean;
  bindCharacter?: boolean;
} = {}): ComicProject {
  const skill = normalizeComicSkill({
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    visualStyle: '简笔粗线，低饱和暖色',
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
    layout: {
      arrangement: options.arrangement,
      panelCount: options.panelCount,
      pageCount: options.pageCount,
    },
    textStyle: options.dialogueMode ? { dialogueMode: options.dialogueMode } : undefined,
  });
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    status: 'locked',
    appearance: '奶油黄圆脸猫',
    referenceImage: { path: '/refs/char-1.png', label: '汤圆参考图' },
  });
  const completed = options.completedPanels ?? 0;
  const pending = options.pendingPanels ?? 0;
  const panels = [
    ...Array.from({ length: completed }, (_, index) => normalizeComicPanel({
      id: `panel-${index}`,
      order: index,
      scene: `场景${index}`,
      characterIds: ['char-1'],
      generationStatus: 'completed',
      imageAsset: { path: `/comic/p${index}.png`, imageId: `img-${index}`, taskId: `task-${index}` },
    })!),
    ...Array.from({ length: pending }, (_, index) => normalizeComicPanel({
      id: `panel-p${index}`,
      order: completed + index,
      scene: `待生成${index}`,
      characterIds: ['char-1'],
      generationStatus: 'pending',
    })!),
  ];
  return normalizeComicProject({
    id: 'p1',
    name: '第一期',
    stage: options.stage ?? 'editing',
    skillSnapshot: skill,
    characterSnapshots: [character!],
    characterBindings: options.bindCharacter === false ? {} : { hero: 'char-1' },
    story: options.story === false ? undefined : {
      title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
      beats: ['a', 'b'], endingType: 'twist', panelCount: options.panelCount ?? 4,
    },
    panels,
    dialogues: [],
    consistency: options.anchor
      ? {
        anchor: { panelId: 'panel-0', path: '/comic/p0.png', imageId: 'img-0', taskId: 'task-0', lockedAt: '2026-09-01T02:00:00.000Z' },
        characterReferences: [],
        generationParams: { size: '1024x1024', quality: 'auto', format: 'png' },
      }
      : undefined,
  })!;
}

// ---------------------------------------------------------------------------
// Presentation 领域模型
// ---------------------------------------------------------------------------

describe('COMIC_PRESENTATION_TEMPLATES：模板完整性（§8）', () => {
  it('id 唯一且覆盖全部标准形式（含 Phase 1.2 新增四种）', () => {
    const ids = COMIC_PRESENTATION_TEMPLATES.map(template => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const expected of ['grid_4', 'grid_9', 'vertical_2', 'horizontal_2', 'vertical_3', 'single', 'multi_page']) {
      expect(ids).toContain(expected);
    }
  });

  it('每个模板都有一句推荐用途与对白适配（不能只有形式名词）', () => {
    for (const template of COMIC_PRESENTATION_TEMPLATES) {
      expect(template.description.length).toBeGreaterThan(6);
      expect(template.dialogueHint.length).toBeGreaterThan(2);
      expect(template.panelsPerPage).toBeGreaterThanOrEqual(1);
      expect(template.columns).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('resolveComicPresentation：从 Skill 解析展示形式', () => {
  it('grid_4：1 页 4 格 2 列（选择卡 / Rail / 组页同源几何）', () => {
    const presentation = resolveComicPresentation(makeProject({ arrangement: 'grid_4', panelCount: 4 }).skillSnapshot);
    expect(presentation.template?.name).toBe('四宫格');
    expect(presentation.outputMode).toBe('single_page_composite');
    expect(presentation.pageCount).toBe(1);
    expect(presentation.panelsPerPage).toBe(4);
    expect(presentation.columns).toBe(2);
    expect(presentation.pages).toHaveLength(1);
    expect(presentation.pages[0]!.panelOrders).toEqual([0, 1, 2, 3]);
  });

  it('grid_9：3 列 9 格', () => {
    const presentation = resolveComicPresentation(makeProject({ arrangement: 'grid_9', panelCount: 9 }).skillSnapshot);
    expect(presentation.columns).toBe(3);
    expect(presentation.totalPanels).toBe(9);
    expect(presentation.pages[0]!.panelOrders).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('vertical_2 一列两格；horizontal_2 两列两格（视觉可区分）', () => {
    expect(resolveComicPresentation(makeProject({ arrangement: 'vertical_2', panelCount: 2 }).skillSnapshot).columns).toBe(1);
    expect(resolveComicPresentation(makeProject({ arrangement: 'horizontal_2', panelCount: 2 }).skillSnapshot).columns).toBe(2);
  });

  it('multi_page：每页 1 张、按 pageCount 分页（§10.4：4 页 = 4 任务不是 16）', () => {
    const presentation = resolveComicPresentation(makeProject({ arrangement: 'multi_page', panelCount: 4, pageCount: 4 }).skillSnapshot);
    expect(presentation.outputMode).toBe('multi_page');
    expect(presentation.panelsPerPage).toBe(1);
    expect(presentation.pageCount).toBe(4);
    expect(presentation.pages.map(page => page.panelOrders)).toEqual([[0], [1], [2], [3]]);
  });

  it('multi_page 未存 pageCount → 缺省等于总格数', () => {
    const presentation = resolveComicPresentation(makeProject({ arrangement: 'multi_page', panelCount: 6 }).skillSnapshot);
    expect(presentation.pageCount).toBe(6);
    expect(presentation.pages).toHaveLength(6);
  });

  it('custom：接近正方网格（ceil(√n) 列），单页不丢格', () => {
    const presentation = resolveComicPresentation(makeProject({ arrangement: 'custom', panelCount: 5 }).skillSnapshot);
    expect(presentation.template).toBeNull();
    expect(presentation.columns).toBe(3);
    expect(presentation.pages).toHaveLength(1);
    expect(presentation.pages[0]!.panelOrders).toEqual([0, 1, 2, 3, 4]);
  });

  it('格数超过模板每页容量 → 按容量分页（grid_4 配 6 格 = 2 页 4+2，不丢格不伪造）', () => {
    const presentation = resolveComicPresentation(
      makeProject({ arrangement: 'grid_4', panelCount: 6 }).skillSnapshot,
    );
    expect(presentation.pageCount).toBe(2);
    expect(presentation.pages[1]!.panelOrders).toEqual([4, 5]);
  });

  it('实际分镜数可覆盖计划格数（分镜草稿 / 组页用实际格数）', () => {
    const skill = makeProject({ arrangement: 'grid_4', panelCount: 4 }).skillSnapshot;
    expect(resolveComicPresentation(skill, { totalPanels: 9 }).pageCount).toBe(3);
  });

  it('标签文案：单页合成与多页各自成句（§8.6 页数 · 每页张数）', () => {
    const grid = resolveComicPresentation(makeProject({ arrangement: 'grid_4', panelCount: 4 }).skillSnapshot);
    expect(comicPresentationLabel(grid)).toBe('四宫格 · 1 页 4 格');
    const multi = resolveComicPresentation(makeProject({ arrangement: 'multi_page', panelCount: 4, pageCount: 4 }).skillSnapshot);
    expect(comicPresentationLabel(multi)).toBe('多页连载 · 4 页 · 每页 1 张 · 共 4 张图');
  });

  it('presentationPatchFor：选择模板 → layout 补丁值（多页带 pageCount）', () => {
    expect(presentationPatchFor(comicPresentationTemplateOf('grid_9')!))
      .toEqual({ panelCount: 9, arrangement: 'grid_9' });
    expect(presentationPatchFor(comicPresentationTemplateOf('multi_page')!))
      .toEqual({ panelCount: 4, arrangement: 'multi_page', pageCount: 4 });
  });
});

// ---------------------------------------------------------------------------
// normalize：旧项目兼容（§70）+ 新字段
// ---------------------------------------------------------------------------

describe('normalize：Presentation 字段归一化（旧 V4.2.5 项目不报错）', () => {
  it('旧四种 arrangement 原样保留；未知值按格数确定性推导（1/2/4/9 → 标准模板，其余 custom）', () => {
    for (const legacy of ['vertical_2', 'grid_4', 'single', 'custom']) {
      expect(normalizeComicSkill({ layout: { arrangement: legacy, panelCount: 3 } }).layout.arrangement).toBe(legacy);
    }
    expect(normalizeComicSkill({ layout: { arrangement: undefined, panelCount: 4 } }).layout.arrangement).toBe('grid_4');
    expect(normalizeComicSkill({ layout: { panelCount: 9 } }).layout.arrangement).toBe('grid_9');
    expect(normalizeComicSkill({ layout: { panelCount: 2 } }).layout.arrangement).toBe('vertical_2');
    expect(normalizeComicSkill({ layout: { panelCount: 1 } }).layout.arrangement).toBe('single');
    expect(normalizeComicSkill({ layout: { panelCount: 7 } }).layout.arrangement).toBe('custom');
  });

  it('dialogueMode：合法值保留，缺省 / 非法 → bubble', () => {
    expect(normalizeComicSkill({ textStyle: { dialogueMode: 'subtitle' } }).textStyle.dialogueMode).toBe('subtitle');
    expect(normalizeComicSkill({}).textStyle.dialogueMode).toBe('bubble');
    expect(normalizeComicSkill({ textStyle: { dialogueMode: 'hologram' } }).textStyle.dialogueMode).toBe('bubble');
  });

  it('pageCount：multi_page 语义字段随 layout 归一化保留', () => {
    const layout = normalizeComicSkill({ layout: { arrangement: 'multi_page', panelCount: 4, pageCount: 6 } }).layout;
    expect(layout.pageCount).toBe(6);
    expect(normalizeComicSkill({}).layout.pageCount).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 用户优先步骤序与门禁（§4/§34/§76~§81）
// ---------------------------------------------------------------------------

describe('getComicStudioFlow：Phase 1.2 用户优先步骤序', () => {
  it('V4.2.11 §D 步骤序 = 本期故事 → 画面与形式 → 角色演员 → 分镜草稿 → 生成漫画画面 → 对白与字幕', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'skill_draft', story: false }));
    expect(flow.steps.map(step => step.id)).toEqual([
      'story', 'skill', 'characters', 'storyboard', 'generate', 'text',
    ]);
    expect(flow.steps.map(step => step.title)).toEqual([
      '本期故事', '画面与形式', '角色演员', '分镜草稿', '生成漫画画面', '对白与字幕',
    ]);
    expect(COMIC_STEP_TITLES.story).toBe('本期故事');
  });

  it('story 是第一步：永远可进（无前置门禁）', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'skill_draft', story: false, bindCharacter: false }));
    const story = flow.steps.find(step => step.id === 'story')!;
    expect(story.enterable).toBe(true);
    expect(flow.currentStep).toBe('story');
  });

  it('画面与形式（skill）门禁 = 故事已确认（§76）', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'skill_draft', story: false }));
    const skill = flow.steps.find(step => step.id === 'skill')!;
    expect(skill.enterable).toBe(false);
    expect(skill.blockedReasons).toEqual(['本期故事尚未确认']);
  });

  it('角色演员门禁 = 故事 + 画面与形式（§77）', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'skill_draft', story: false }));
    const characters = flow.steps.find(step => step.id === 'characters')!;
    expect(characters.enterable).toBe(false);
    expect(characters.blockedReasons).toEqual(['本期故事尚未确认']);
  });

  it('对白与字幕允许 partial：一格成图即可进（§81），生成漫画画面仍未完成不堵死文字层', () => {
    const project = makeProject({ stage: 'generating_panels', anchor: true, completedPanels: 1, pendingPanels: 3 });
    const flow = getComicStudioFlow(project);
    expect(flow.imagesReady).toBe(false);
    expect(flow.steps.find(step => step.id === 'generate')!.status).toBe('current');
    const text = flow.steps.find(step => step.id === 'text')!;
    expect(text.enterable).toBe(true);
    expect(text.blockedReasons).toEqual([]);
  });

  it('零成图时对白步骤不放行并给原因', () => {
    const flow = getComicStudioFlow(makeProject({ stage: 'generating_anchor', anchor: true, completedPanels: 0, pendingPanels: 4 }));
    const text = flow.steps.find(step => step.id === 'text')!;
    expect(text.enterable).toBe(false);
    expect(text.blockedReasons).toEqual(['至少一格成图后才能编辑对白']);
  });
});

// ---------------------------------------------------------------------------
// applyStoryOnlyToProject（Step 1 确认故事）
// ---------------------------------------------------------------------------

describe('applyStoryOnlyToProject：只写 story，旧分镜 stale 化', () => {
  it('故事确认后旧分镜整体 stale（供回看不进生成输入），Anchor 档案保留（§42/§74）', () => {
    const project = makeProject({ anchor: true, completedPanels: 2, pendingPanels: 2 });
    const nextStory = {
      title: '新故事', topic: '新主题', summary: '改了', characterIds: ['char-1'],
      beats: ['x', 'y'], endingType: 'punchline' as const, panelCount: 4,
    };
    const { project: next, staleMarked } = applyStoryOnlyToProject(project, nextStory);
    expect(next.story?.title).toBe('新故事');
    expect(next.panels.every(panel => panel.stale)).toBe(true);
    expect(staleMarked).toBe(2); // 只数带图的（上一代成图）
    expect(next.consistency?.anchor).toBeDefined();
  });

  it('内容一致的故事重复确认 = 幂等 no-op（不重复 stale 化）', () => {
    const project = makeProject({ completedPanels: 2, pendingPanels: 0 });
    const same = project.story!;
    const { project: next, staleMarked } = applyStoryOnlyToProject(project, same);
    expect(staleMarked).toBe(0);
    expect(next).toBe(project);
  });
});

// ---------------------------------------------------------------------------
// §86/§88 聚焦 selector
// ---------------------------------------------------------------------------

describe('getComicProjectSummary / getStoryOverview（单一事实源）', () => {
  it('Summary：故事 / 形式 / 角色 / 锚点 / 成图 / 下一步 一行可读', () => {
    const summary = getComicProjectSummary(makeProject({ anchor: true, completedPanels: 2, pendingPanels: 2 }));
    expect(summary.storyStatus).toBe('ready');
    expect(summary.presentationStatus).toBe('confirmed');
    expect(summary.requiredCharacters).toBe(1);
    expect(summary.lockedCharacters).toBe(1);
    expect(summary.anchorStatus).toBe('locked');
    expect(summary.generatedPanels).toBe(2);
    expect(summary.totalPanels).toBe(4);
    expect(summary.currentStep).toBe('generate');
    expect(summary.nextStep).toBe('text');
    expect(summary.nextStepTitle).toBe('对白与字幕');
  });

  it('未确认形式 → presentationStatus=unconfirmed', () => {
    const summary = getComicProjectSummary(makeProject({ stage: 'skill_draft', story: true }));
    expect(summary.presentationStatus).toBe('unconfirmed');
  });

  it('StoryOverview：Hero Card 同源字段（一句话 / 节拍 / 结尾 / 展示形式 / 页数）', () => {
    const overview = getStoryOverview(makeProject({ arrangement: 'grid_4', panelCount: 4 }));
    expect(overview.comicName).toBe('第一期');
    expect(overview.storyTitle).toBe('周一例会');
    expect(overview.oneLiner).toBe('又延期');
    expect(overview.beats).toEqual(['a', 'b']);
    expect(overview.endingTypeLabel).toBe('反转');
    expect(overview.characterNames).toEqual(['汤圆']);
    expect(overview.presentationLabel).toBe('四宫格 · 1 页 4 格');
    expect(overview.totalPanels).toBe(4);
    expect(overview.pageCount).toBe(1);
  });

  it('无故事 → 空字段不抛错（oneLiner 空串 / title null）', () => {
    const overview = getStoryOverview(makeProject({ story: false }));
    expect(overview.storyTitle).toBeNull();
    expect(overview.oneLiner).toBe('');
    expect(overview.beats).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Presentation 应用（§8/§12/§73/§74）
// ---------------------------------------------------------------------------

describe('applyPresentationToProject：选择展示形式（§73 按真实依赖标 stale）', () => {
  it('同模板重选 = 幂等 no-op', () => {
    const project = makeProject({ arrangement: 'grid_4', panelCount: 4 });
    const outcome = applyPresentationToProject(project, comicPresentationTemplateOf('grid_4')!);
    expect(outcome.changed).toBe(false);
    expect(outcome.project).toBe(project);
  });

  it('四宫格 → 九宫格：几何写入 + story.panelCount 同步 + 活跃分镜整体 stale + Anchor 保留', () => {
    const project = makeProject({ arrangement: 'grid_4', panelCount: 4, anchor: true, completedPanels: 2, pendingPanels: 2 });
    const outcome = applyPresentationToProject(project, comicPresentationTemplateOf('grid_9')!);
    expect(outcome.changed).toBe(true);
    expect(outcome.panelCountChanged).toBe(true);
    expect(outcome.project.skillSnapshot.layout.arrangement).toBe('grid_9');
    expect(outcome.project.skillSnapshot.layout.panelCount).toBe(9);
    expect(outcome.project.story?.panelCount).toBe(9);
    expect(outcome.project.panels.every(panel => panel.stale)).toBe(true);
    expect(outcome.project.consistency?.anchor).toBeDefined();
  });

  it('上下双格 → 左右双格（格数不变）：面板图不受影响不 stale（§74 排版-only 变化）', () => {
    const project = makeProject({ arrangement: 'vertical_2', panelCount: 2, completedPanels: 2 });
    const outcome = applyPresentationToProject(project, comicPresentationTemplateOf('horizontal_2')!);
    expect(outcome.changed).toBe(true);
    expect(outcome.panelCountChanged).toBe(false);
    expect(outcome.project.skillSnapshot.layout.arrangement).toBe('horizontal_2');
    expect(outcome.project.panels.every(panel => !panel.stale)).toBe(true);
    expect(outcome.project.story?.panelCount).toBe(2);
  });

  it('多页连载：补丁带 pageCount（每页 1 张 · 页数=格数）', () => {
    const project = makeProject({ arrangement: 'grid_4', panelCount: 4 });
    const outcome = applyPresentationToProject(project, comicPresentationTemplateOf('multi_page')!);
    expect(outcome.project.skillSnapshot.layout.arrangement).toBe('multi_page');
    expect(outcome.project.skillSnapshot.layout.pageCount).toBe(4);
  });

  it('story.panelCount 已等于模板格数时不算格数变化（换形式不重出分镜）', () => {
    const project = makeProject({ arrangement: 'vertical_2', panelCount: 2, story: true });
    // makeProject 的 story.panelCount 跟随 panelCount=2
    const outcome = applyPresentationToProject(project, comicPresentationTemplateOf('horizontal_2')!);
    expect(outcome.panelCountChanged).toBe(false);
  });
});

describe('applyDialogueModeToProject / applyVisualStyleToProject（§12 文字与画风独立）', () => {
  it('对白方式：同值 no-op；换值只写 textStyle.dialogueMode，面板 / 分镜零改动', () => {
    const project = makeProject({ completedPanels: 2 });
    expect(applyDialogueModeToProject(project, 'bubble')).toBe(project);
    const next = applyDialogueModeToProject(project, 'subtitle');
    expect(next.skillSnapshot.textStyle.dialogueMode).toBe('subtitle');
    expect(next.panels).toBe(project.panels);
    expect(next.story).toEqual(project.story);
  });

  it('视觉风格：同值 / 空串 no-op；换值写 promptText 级画风，不动其他字段', () => {
    const project = makeProject({});
    expect(applyVisualStyleToProject(project, project.skillSnapshot.visualStyle)).toBe(project);
    expect(applyVisualStyleToProject(project, '  ')).toBe(project);
    const next = applyVisualStyleToProject(project, '萌系简笔：圆润粗线条，大眼睛低细节');
    expect(next.skillSnapshot.visualStyle).toBe('萌系简笔：圆润粗线条，大眼睛低细节');
    expect(next.skillSnapshot.layout).toBe(project.skillSnapshot.layout);
  });
});
