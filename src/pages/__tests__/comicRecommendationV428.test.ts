import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.2.8「AI 漫画创意入口与推荐体验重构」专项守卫（docs/ai-comic/16-DESIGN §90~§98）。
 *
 * 锁定的规范：
 * - §90 漫画形式选择器：可视化小卡（radiogroup）+ AI 自动 + 全部真实模板 + 当前选择反馈；
 * - §91/§92 auto / fixed 约束：presentation.ts 单点域模型（Label / Hint / Spec / 归一）；
 * - §93 状态规则：编辑需求 / 失败重试 / 换个需求都不重置形式约束（只在弹窗重开时归位）；
 * - §94/§95 Story-first 结果页：Mini Concept Card + 主区顺序（标题 → 一句话 → 视觉预演 →
 *   包袱 → 角色 → 形式元信息 → 使用 CTA → 完整故事折叠 → 创作详情折叠）+ 切方案回滚顶部；
 * - §96 Concept Transfer：presentationSource 全链路（弹窗 → 页面 → store → 项目文档）
 *   + user_fixed 排版锁（对话式补丁不得改形式；显式选择卡 = 唯一改形式入口）；
 * - §98 UI Skill：新自定义控件进 conformance 白名单 + focus-visible；AI 自动卡用 SVG 不用 Emoji。
 *
 * （planner 侧 Prompt / Validator / Repair / 角色槽位合并在 comicPlanner.test.ts。）
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const newProjectDialog = read('../../features/comic/components/ComicNewProjectDialog.tsx');
const storyPreview = read('../../features/comic/components/ComicStoryPreview.tsx');
const formPreviewMini = read('../../features/comic/components/ComicFormPreviewMini.tsx');
const skillStage = read('../../features/comic/components/ComicSkillStage.tsx');
const comicStudio = read('../ComicStudio.tsx');
const comicStore = read('../../store/useComicStore.ts');

import {
  COMIC_PRESENTATION_CONSTRAINT_TEMPLATES,
  COMIC_PRESENTATION_TEMPLATES,
  comicPresentationConstraintHint,
  comicPresentationConstraintLabel,
  comicPresentationConstraintSpec,
  comicPresentationTemplateOf,
  comicPresentationTemplateShortLabel,
  normalizeComicPresentationConstraint,
  presentationPatchFor,
  resolveConceptPresentation,
} from '../../features/comic/presentation';
import {
  applyPresentationToProject,
  guardComicPatchesAgainstPresentationLock,
} from '../../features/comic/domain';
import { normalizeComicProject, normalizeComicSkill } from '../../features/comic/normalize';
import type { ComicProject, ComicSkillPatch } from '../../features/comic/types';

describe('§90 漫画形式约束域模型（presentation.ts 单点）', () => {
  test('约束模板 = 全部 7 个真实模板（custom 不可推荐）', () => {
    expect(COMIC_PRESENTATION_CONSTRAINT_TEMPLATES.map(template => template.id)).toEqual([
      'grid_4', 'grid_9', 'vertical_2', 'horizontal_2', 'vertical_3', 'single', 'multi_page',
    ]);
    expect(COMIC_PRESENTATION_CONSTRAINT_TEMPLATES).toBe(COMIC_PRESENTATION_TEMPLATES);
  });

  test('小卡几何短说明：单页「1 页 · N 格」；多页「4 页 · 每页 1 张」', () => {
    expect(comicPresentationTemplateShortLabel(comicPresentationTemplateOf('grid_4')!)).toBe('1 页 · 4 格');
    expect(comicPresentationTemplateShortLabel(comicPresentationTemplateOf('grid_9')!)).toBe('1 页 · 9 格');
    expect(comicPresentationTemplateShortLabel(comicPresentationTemplateOf('single')!)).toBe('1 页 · 1 格');
    expect(comicPresentationTemplateShortLabel(comicPresentationTemplateOf('multi_page')!)).toBe('4 页 · 每页 1 张');
  });

  test('当前选择文案：auto = AI 自动推荐；fixed = 形式名 + 页格几何', () => {
    expect(comicPresentationConstraintLabel({ mode: 'auto' })).toBe('AI 自动推荐');
    expect(comicPresentationConstraintLabel({ mode: 'fixed', templateId: 'grid_4' })).toBe('四宫格 · 1 页 · 4 格');
    expect(comicPresentationConstraintLabel({ mode: 'fixed', templateId: 'multi_page' })).toBe('多页连载 · 4 页 · 每页 1 张');
  });

  test('当前选择动态说明：fixed = 三方案都保持该形式；auto = AI 分别选形式', () => {
    expect(comicPresentationConstraintHint({ mode: 'fixed', templateId: 'grid_4' }))
      .toContain('三个方案都会保持四宫格（1 页 4 格）');
    expect(comicPresentationConstraintHint({ mode: 'auto' }))
      .toContain('AI 会为 3 个不同故事分别选择最适合的漫画形式');
  });

  test('约束归一：fixed 缺模板 / 模板不存在 → auto；合法 fixed 保留', () => {
    expect(normalizeComicPresentationConstraint(undefined)).toEqual({ mode: 'auto' });
    expect(normalizeComicPresentationConstraint({ mode: 'fixed' })).toEqual({ mode: 'auto' });
    expect(normalizeComicPresentationConstraint({ mode: 'fixed', templateId: 'custom' as never }))
      .toEqual({ mode: 'auto' });
    expect(normalizeComicPresentationConstraint({ mode: 'fixed', templateId: 'grid_9' }))
      .toEqual({ mode: 'fixed', templateId: 'grid_9' });
  });

  test('约束期望几何（Validator / Prompt 共用）：multi_page = 4 页 4 格；其余 1 页', () => {
    expect(comicPresentationConstraintSpec({ mode: 'fixed', templateId: 'multi_page' }))
      .toMatchObject({ pageCount: 4, totalPanels: 4 });
    expect(comicPresentationConstraintSpec({ mode: 'fixed', templateId: 'grid_9' }))
      .toMatchObject({ pageCount: 1, totalPanels: 9 });
    expect(comicPresentationConstraintSpec({ mode: 'auto' })).toBeNull();
  });
});

describe('§90 选择器 UI（可视化小卡，非 Select / 非 Chip）', () => {
  test('radiogroup + AI 自动卡（SVG 星形，不用 Emoji）+ 全部模板小卡（短几何说明单点）', () => {
    expect(newProjectDialog).toContain('role="radiogroup"');
    expect(newProjectDialog).toContain('aria-label="漫画形式"');
    expect(newProjectDialog).toContain('data-testid="comic-form-selector"');
    expect(newProjectDialog).toContain('COMIC_PRESENTATION_CONSTRAINT_TEMPLATES.map');
    expect(newProjectDialog).toContain('data-template-id="auto"');
    expect(newProjectDialog).toContain('comic-form-selector-icon');
    // AI 自动示意 = 内联 SVG（UI Skill：不引入新 Emoji）
    expect(newProjectDialog).not.toContain('✨');
    // 模板小卡几何口径 = comicPresentationTemplateShortLabel 单点（不自画第二套几何）
    expect(newProjectDialog).toContain('data-template-id={template.id}');
    expect(newProjectDialog).toContain('comicPresentationTemplateShortLabel(template)');
  });

  test('当前选择即时反馈块：Label + 动态 Hint', () => {
    expect(newProjectDialog).toContain('data-testid="comic-form-current"');
    expect(newProjectDialog).toContain('comicPresentationConstraintLabel(constraint)');
    expect(newProjectDialog).toContain('comicPresentationConstraintHint(constraint)');
  });
});

describe('§93 状态规则（约束独立于需求文本）', () => {
  test('形式约束重置只发生在弹窗重开（useEffect props.open）内，全文件仅此一处 auto 归位', () => {
    const effectBody = newProjectDialog.slice(
      newProjectDialog.indexOf('useEffect(() => {'),
      newProjectDialog.indexOf('if (!props.open) return null;'),
    );
    expect(effectBody).toContain('setConstraint({ mode: \'auto\' })');
    // 推荐链路（runRecommend → createFromDraft）不触碰约束状态
    const recommendChain = newProjectDialog.slice(
      newProjectDialog.indexOf('const runRecommend'),
      newProjectDialog.indexOf('const createFromLibrary'),
    );
    expect(recommendChain).not.toContain('setConstraint(');
  });

  test('推荐请求携带结构化约束；重试（onRetry → runRecommend）复用当前约束状态', () => {
    expect(newProjectDialog).toContain('presentationConstraint: constraint');
    expect(newProjectDialog).toContain('onRetry={run.status === \'failed\' ? () => void runRecommend() : undefined}');
  });

  test('「换个需求」只回输入页：需求与形式选择全部保留（不重置 constraint / concepts）', () => {
    expect(newProjectDialog).toContain('换个需求');
    const buttonText = newProjectDialog.indexOf('>换个需求</button>');
    expect(buttonText).toBeGreaterThan(-1);
    const backButton = newProjectDialog.slice(
      newProjectDialog.lastIndexOf('<button', buttonText),
      newProjectDialog.indexOf('</button>', buttonText),
    );
    expect(backButton).toContain("setPhase('requirement')");
    expect(backButton).not.toContain('setConstraint');
    expect(backButton).not.toContain('setConcepts');
  });
});

describe('§94/§95 Story-first 结果页（Mini Card + 主区顺序 + 折叠）', () => {
  test('方案切换 = Mini Concept Card（几何小图 + 方案N + 标题 + 形式行 + 基调行），tab 语义保留', () => {
    expect(newProjectDialog).toContain('comic-concept-mini-row');
    expect(newProjectDialog).toContain('role="tab"');
    expect(newProjectDialog).toContain('ConceptFormGlyph');
    expect(newProjectDialog).toContain('comic-concept-mini-title');
    expect(newProjectDialog).toContain('comic-concept-mini-form');
    expect(newProjectDialog).toContain('comic-concept-mini-tone');
  });

  test('主区顺序 §28：标题 → 一句话 → 视觉预演 → 包袱 → 角色 → 形式元信息 → 使用 CTA → 完整故事 → 创作详情', () => {
    const order = [
      'comic-concept-story-title',
      'comic-concept-oneliner',
      '<ComicStoryPreview',
      'comic-concept-punchline',
      'comic-concept-characters',
      'comic-concept-presentation',
      'comic-concept-use',
      'comic-concept-fullstory',
      'comic-concept-advanced',
    ] as const;
    for (let index = 1; index < order.length; index += 1) {
      expect(
        newProjectDialog.indexOf(order[index]),
        `${order[index - 1]} 应在 ${order[index]} 之前`,
      ).toBeGreaterThan(newProjectDialog.indexOf(order[index - 1]));
    }
  });

  test('完整故事默认折叠（fullStoryOpen=false），展开走 secondary-sm 按钮 + aria-expanded', () => {
    expect(newProjectDialog).toContain('setFullStoryOpen] = useState(false)');
    expect(newProjectDialog).toContain('展开完整故事');
    expect(newProjectDialog).toContain('aria-expanded={fullStoryOpen}');
  });

  test('§29 切换方案 / 阶段时主区回滚顶部', () => {
    expect(newProjectDialog).toContain('bodyRef.current?.scrollTo({ top: 0 })');
    expect(newProjectDialog).toContain('}, [activeIndex, phase]);');
  });

  test('创建回顾（preview 阶段）复用 ComicStoryPreview 紧凑档 + 标注形式来源', () => {
    expect(newProjectDialog).toContain('你指定的形式');
    expect(newProjectDialog).toContain('AI 推荐的形式');
    const recap = newProjectDialog.slice(
      newProjectDialog.indexOf('comic-concept-recap'),
      newProjectDialog.indexOf('comic-skill-facts'),
    );
    expect(recap).toContain('<ComicStoryPreview');
    expect(recap).toContain('compact');
  });
});

describe('§95 ComicStoryPreview（格子即 Beat，纯 CSS 零计费）', () => {
  test('零 Image API：无 <img> / 无 api import / 无 invoke / 无生图链路', () => {
    expect(storyPreview).not.toContain('<img');
    expect(storyPreview).not.toContain("from '../../../services/api'");
    expect(storyPreview).not.toContain('invoke(');
    for (const forbidden of ['comicTask', 'useTaskStore', 'billingService', 'createSeriesTask']) {
      expect(storyPreview.includes(forbidden), forbidden).toBe(false);
    }
  });

  test('格内三件套：序号 + 短标题 + 概要（格子本身就是 Beat，不再单列节拍清单）', () => {
    for (const marker of ['comic-story-cell-order', 'comic-story-cell-title', 'comic-story-cell-summary']) {
      expect(storyPreview).toContain(marker);
    }
    expect(storyPreview).toContain('DENSE_CELL_THRESHOLD');
    expect(storyPreview).toContain('is-dense');
    expect(storyPreview).toContain('is-empty');
  });

  test('单格 = 场景卡（不是空白矩形）：标题 + 概要 + 分隔线 + 结尾包袱', () => {
    for (const marker of [
      'comic-story-preview-single',
      'comic-story-scene-tag',
      'comic-story-scene-title',
      'comic-story-scene-summary',
      'comic-story-scene-divider',
      'comic-story-scene-punchline',
    ]) {
      expect(storyPreview).toContain(marker);
    }
  });

  test('多页 = 真实页帧：每页一帧 + 页标签 + 「N 页 · 每页 1 格 · 共 N 格」+ 超出折叠', () => {
    expect(storyPreview).toContain('第 {page.pageIndex + 1} 页');
    expect(storyPreview).toContain('comic-story-page-summary');
    expect(storyPreview).toContain('每页 {presentation.panelsPerPage} 格');
    expect(storyPreview).toContain('comic-story-more');
  });

  test('几何同源：pages / columns 来自 presentation prop（resolveConceptPresentation 单点计算）', () => {
    expect(storyPreview).toContain('page.columns');
    expect(storyPreview).toContain('page.panelOrders');
    expect(storyPreview).toContain("from '../presentation'");
    // 选择卡 / Rail 的几何缩略由 ComicFormPreviewMini 承担（分工不回退；
    // 旧 ComicLayoutPreview 已随 V4.2.13 死代码清理删除）
    expect(formPreviewMini).toContain('page?.columns');
  });
});

describe('§96 Concept Transfer（presentationSource 全链路 + 排版锁）', () => {
  test('弹窗 → onCreate 携带 presentationSource（fixed=user_fixed / auto=ai_recommended）', () => {
    expect(newProjectDialog).toContain(
      "presentationSource: constraint.mode === 'fixed' ? 'user_fixed' : 'ai_recommended'",
    );
  });

  test('页面 handleCreate → store createProject 透传', () => {
    expect(comicStudio).toContain('presentationSource: input.presentationSource');
    expect(comicStore).toContain('presentationSource?: ComicPresentationSource');
    expect(comicStore).toContain('presentationSource,');
  });

  test('presentationSource 持久化往返：合法值保留，非法值丢弃', () => {
    const skill = normalizeComicSkill({ name: '小鸭冷笑话', comicForm: '四格漫画' });
    const base = {
      id: 'project-1',
      name: '第一期',
      stage: 'skill_draft',
      skillSnapshot: skill,
      characterSnapshots: [],
      characterBindings: {},
      panels: [],
      dialogues: [],
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    expect(normalizeComicProject({ ...base, presentationSource: 'user_fixed' })?.presentationSource)
      .toBe('user_fixed');
    expect(normalizeComicProject({ ...base, presentationSource: 'ai_recommended' })?.presentationSource)
      .toBe('ai_recommended');
    expect(normalizeComicProject({ ...base, presentationSource: 'nope' })?.presentationSource)
      .toBeUndefined();
    expect(normalizeComicProject(base)?.presentationSource).toBeUndefined();
  });

  test('显式选择卡 = 唯一改形式入口：applyPresentationToProject 刷新 user_fixed 基线', () => {
    const skill = normalizeComicSkill({ name: '小鸭冷笑话', comicForm: '四格漫画' });
    const project = {
      id: 'project-1',
      name: '第一期',
      stage: 'skill_draft' as const,
      skillSnapshot: skill,
      characterSnapshots: [],
      characterBindings: {},
      panels: [],
      dialogues: [],
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    };
    const template = comicPresentationTemplateOf('grid_9')!;
    const outcome = applyPresentationToProject(project as ComicProject, template);
    expect(outcome.changed).toBe(true);
    expect(outcome.project.presentationSource).toBe('user_fixed');
    expect(outcome.project.skillSnapshot.layout).toMatchObject(presentationPatchFor(template));
  });

  test('排版锁：user_fixed 下 layout 补丁被过滤，其余补丁放行；auto / 未标记全放行', () => {
    const patches: ComicSkillPatch[] = [
      { field: 'layout.arrangement', value: 'grid_9' },
      { field: 'layout.panelCount', value: 9 },
      { field: 'humorStyle', value: '冷幽默' },
    ];
    const locked = guardComicPatchesAgainstPresentationLock(patches, 'user_fixed');
    expect(locked.patches.map(patch => patch.field)).toEqual(['humorStyle']);
    expect(locked.ignored).toEqual(['layout.arrangement', 'layout.panelCount']);
    for (const source of ['ai_recommended', undefined] as const) {
      const pass = guardComicPatchesAgainstPresentationLock(patches, source);
      expect(pass.patches).toHaveLength(3);
      expect(pass.ignored).toEqual([]);
    }
  });

  test('ComicSkillStage 接线：对话式微调补丁先过排版锁，命中锁时 toast 明示唯一改形式入口', () => {
    expect(skillStage).toContain('guardComicPatchesAgainstPresentationLock(outcome.patches, project.presentationSource)');
    expect(skillStage).toContain('形式选择卡');
  });
});

describe('§98 UI Skill（新自定义控件进 conformance 白名单 + 焦点）', () => {
  test('conformance 白名单收录两个新控件类（comicUiConformance.test.ts 同步维护）', () => {
    const conformance = read('./comicUiConformance.test.ts');
    expect(conformance).toContain("'comic-form-selector-card'");
    expect(conformance).toContain("'comic-concept-mini'");
    expect(conformance).toMatch(/\.comic-form-selector-card:focus-visible/);
    expect(conformance).toMatch(/\.comic-concept-mini:focus-visible/);
  });

  test('ComicStudio.css：新控件 focus-visible 同规范焦点 + 全令牌颜色（零 hex）', () => {
    const studioCss = read('../ComicStudio.css');
    expect(studioCss).toMatch(/\.comic-form-selector-card:focus-visible/);
    expect(studioCss).toMatch(/\.comic-concept-mini:focus-visible/);
    const section = studioCss.slice(studioCss.indexOf('V4.2.8'));
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
