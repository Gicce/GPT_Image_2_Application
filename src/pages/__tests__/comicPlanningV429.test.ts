import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.2.9「AI 漫画规划反馈与故事审定 UI 收口」专项守卫（docs/ai-comic/17 §四~§六 + §55 红线）。
 *
 * 锁定的规范：
 * - §40 multi-page 小卡根因修复：统一 72×96 固定画布（ComicFormPreviewMini），
 *   preview 内不渲染「第 N 页」文字标签；禁止 transform:scale() 糊住问题；
 * - §41 AIPlanningSurface 唯一规划状态面：无百分比（阶段清单 ✓/●/○ + 真实计时）、
 *   COMIC_PLANNER_STAGE_LABEL 唯一文案源、失败原位重试、居中舞台 + inline 两档；
 * - §42 推荐 / 技能起草 / 本期故事三段规划都进内容区居中 Planning Surface
 *   （顶部 recap 保留输入摘要；失败 dismiss 回输入态，输入不回退）；
 * - §43 故事审定 Story Hero 层级（标题 → chips → 概要 → 节拍网格（几何同源）→
 *   Punchline callout → 角色 → 确认 = 唯一 Primary）；Replan 红线：旧 Story 不清空。
 */

const read = (path: string): string =>
  readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const newProjectDialog = read('../../features/comic/components/ComicNewProjectDialog.tsx');
const storyStage = read('../../features/comic/components/ComicStoryStage.tsx');
const characterStage = read('../../features/comic/components/ComicCharacterStage.tsx');
const storyboardStage = read('../../features/comic/components/ComicStoryboardStage.tsx');
const planningSurface = read('../../features/comic/components/AIPlanningSurface.tsx');
const previewMini = read('../../features/comic/components/ComicFormPreviewMini.tsx');
const progressModel = read('../../features/comic/comicPlannerProgress.ts');
const comicCss = read('../ComicStudio.css');

import {
  COMIC_PLANNER_STAGE_LABEL,
  comicPlannerElapsedSeconds,
  isComicPlannerRunning,
} from '../../features/comic/comicPlannerProgress';
import {
  comicPresentationTemplateOf,
  presentationPatchFor,
  resolveComicPresentation,
  resolveConceptPresentation,
} from '../../features/comic/presentation';
import { normalizeComicSkill } from '../../features/comic/normalize';
import type { ComicSkill } from '../../features/comic/types';

const skillOf = (templateId: 'grid_4' | 'grid_9' | 'vertical_2' | 'horizontal_2' | 'multi_page'): ComicSkill => {
  const base = normalizeComicSkill({ name: '小鸭冷笑话', comicForm: '四格漫画' })!;
  return { ...base, layout: { ...base.layout, ...presentationPatchFor(comicPresentationTemplateOf(templateId)!) } };
};

describe('§40 multi-page 小卡根因修复（统一画布，无文字页标签，无 scale 补丁）', () => {
  test('旧进度卡组件已删除，全部消费方迁移 AIPlanningSurface（无残留 import）', () => {
    expect(existsSync(resolve(__dirname, '../../features/comic/components/ComicPlannerProgressCard.tsx'))).toBe(false);
    for (const source of [newProjectDialog, storyStage, characterStage, storyboardStage]) {
      expect(source.includes('ComicPlannerProgressCard'), '旧组件 import 残留').toBe(false);
    }
  });

  test('ComicFormPreviewMini：统一 72×96 固定画布 + overflow hidden（根因 A：不再各卡各自 max-width）', () => {
    expect(previewMini).toContain('comic-form-preview-mini');
    const block = comicCss.slice(comicCss.indexOf('.comic-form-preview-mini {'));
    expect(block).toContain('width: 72px');
    expect(block).toContain('height: 96px');
    expect(block.slice(0, block.indexOf('}') + 1)).toContain('overflow: hidden');
  });

  test('多页 = 重叠页 +「+N 页」角标；preview 内不渲染「第 N 页」文字标签（根因 B/C）', () => {
    expect(previewMini).toContain("presentation.outputMode === 'multi_page' && presentation.pageCount > 1");
    expect(previewMini).toContain('comic-form-preview-page is-back');
    expect(previewMini).toContain('comic-form-preview-page is-front');
    expect(previewMini).toContain('+{hiddenPages} 页');
    // 去注释后 JSX 里不得出现页文字标签（旧实现 absolute top:-8px nowrap 的根因）
    const jsxOnly = previewMini.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(jsxOnly).not.toMatch(/>\s*第[0-9一二三四]/);
    expect(jsxOnly).not.toContain('comic-form-preview-page-label');
  });

  test('禁止 scale() 糊住问题：漫画样式表无任何 transform: scale', () => {
    expect(comicCss).not.toMatch(/transform:\s*scale/);
  });

  test('单页 preview 几何同源：columns 来自 presentation（grid_4=2 / grid_9=3 / 竖排=1）', () => {
    expect(resolveConceptPresentation({ layout: { panelCount: 4, arrangement: 'grid_4' } }).pages[0]!.columns).toBe(2);
    expect(resolveConceptPresentation({ layout: { panelCount: 9, arrangement: 'grid_9' } }).pages[0]!.columns).toBe(3);
    expect(resolveConceptPresentation({ layout: { panelCount: 3, arrangement: 'vertical_3' } }).pages[0]!.columns).toBe(1);
    expect(previewMini).toContain('gridTemplateColumns');
    // 选择器卡全部走 ComicFormPreviewMini + resolveConceptPresentation（不自画第二套几何）
    expect(newProjectDialog).toContain('<ComicFormPreviewMini');
    expect(newProjectDialog).toContain('resolveConceptPresentation({');
  });
});

describe('§41 AIPlanningSurface 唯一规划状态面（无百分比 + 阶段清单 + 真实计时）', () => {
  test('百分比彻底移除：进度模型无 percent 派生（注释除外），规划 UI 源码无 % 字面量', () => {
    // 去注释后不得再出现 percent 标识（V4.2.9 裁定：阶段锚点百分比整体删除）
    const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(strip(progressModel)).not.toMatch(/[Pp]ercent/);
    for (const source of [planningSurface, storyStage, newProjectDialog]) {
      expect(strip(source).includes('%'), '规划 UI 出现百分比').toBe(false);
    }
  });

  test('阶段清单 ✓/●/○：真实管道边界三阶段（retrying 是 planning 的回退事件，不入清单）', () => {
    expect(planningSurface).toContain("['resolving', 'planning', 'validating']");
    expect(planningSurface).toContain("'✓' : state === 'current' ? '●' : '○'");
    expect(planningSurface).toContain('COMIC_PLANNER_STAGE_LABEL');
    expect(COMIC_PLANNER_STAGE_LABEL.planning).toBe('AI 规划中');
    expect(COMIC_PLANNER_STAGE_LABEL.retrying).toBe('首次结果无效 · 自动重试');
  });

  test('阶段模型纯函数：运行态枚举 + 已用时秒数（真实计时，向下取整且不为负）', () => {
    for (const status of ['resolving', 'planning', 'validating', 'retrying'] as const) {
      expect(isComicPlannerRunning(status)).toBe(true);
    }
    for (const status of ['idle', 'completed', 'failed'] as const) {
      expect(isComicPlannerRunning(status)).toBe(false);
    }
    expect(comicPlannerElapsedSeconds(1000, 2500)).toBe(1);
    expect(comicPlannerElapsedSeconds(5000, 4000)).toBe(0);
  });

  test('失败态：原位错误 + 重试 + 返回（secondary-sm，不抢唯一 Primary）；完成态 ✓ 标题', () => {
    expect(planningSurface).toContain("failed ? 'AI 规划失败'");
    expect(planningSurface).toContain("completed ? `✓ ${title.replace(/^AI 正在/, '')}完成`");
    expect(planningSurface.match(/className="app-btn app-btn-secondary app-btn-sm"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(planningSurface).toContain('data-testid="comic-planning-retry"');
    expect(planningSurface).toContain('data-testid="comic-planning-dismiss"');
    // a11y：屏幕阅读器可感知规划状态变化
    expect(planningSurface).toContain('role="status"');
    expect(planningSurface).toContain('aria-live="polite"');
  });

  test('CSS：居中舞台档（内容区中央 min(560px,100%)）+ inline 卡内档 + 动画降级', () => {
    const block = comicCss.slice(comicCss.indexOf('.comic-planning-surface {'));
    expect(block).toContain('width: min(560px, 100%)');
    expect(block).toContain('margin: 40px auto 16px');
    expect(comicCss).toContain('.comic-planning-surface.is-inline {');
    expect(comicCss).toMatch(/\.comic-planning-surface-spinner[\s\S]{0,300}?animation: comic-planning-spin/);
    expect(comicCss).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]{0,200}?\.comic-planning-surface-spinner\s*\{\s*animation: none/);
  });

  test('character / storyboard 保持卡内原位反馈（inline 档，不居中抢占舞台）', () => {
    for (const source of [characterStage, storyboardStage]) {
      expect(source).toContain('<AIPlanningSurface');
      expect(source).toContain('inline');
    }
  });
});

describe('§42 三段规划都进内容区居中 Planning Surface（不再沉底）', () => {
  test('推荐：requirement 阶段 IIFE 顶部切 planning stage + recap（你的要求 / 漫画形式保留可见）', () => {
    expect(newProjectDialog).toContain('comic-recommend-planning-stage');
    expect(newProjectDialog).toContain('comic-planning-recap-label">你的要求');
    expect(newProjectDialog).toContain('comic-planning-recap-label">漫画形式');
    expect(newProjectDialog).toContain('title="AI 正在规划漫画"');
    // 居中舞台渲染在表单分支之前（替换表单，不是追加在表单下方）
    expect(newProjectDialog.indexOf('comic-recommend-planning-stage'))
      .toBeLessThan(newProjectDialog.indexOf('id="comic-requirement"'));
    // 失败 dismiss 回输入态（RUN_IDLE 重置，requirement 输入不回退）
    expect(newProjectDialog).toContain('dismissLabel="返回修改需求"');
  });

  test('技能起草：concepts 阶段同样居中（recap = 已选故事；重试依赖 selectedConcept）', () => {
    expect(newProjectDialog).toContain('comic-skill-planning-stage');
    expect(newProjectDialog).toContain('comic-planning-recap-label">已选故事');
    expect(newProjectDialog).toContain('title="AI 正在起草漫画技能"');
    expect(newProjectDialog).toContain('run.status === \'failed\' && selectedConcept ? () => void runDraftSkill(selectedConcept)');
    expect(newProjectDialog).toContain('dismissLabel="返回选择故事"');
    expect(newProjectDialog.indexOf('comic-skill-planning-stage'))
      .toBeLessThan(newProjectDialog.indexOf('comic-concept-mini-row'));
  });

  test('本期故事：requirement 阶段居中 + recap 本期需求；标题与 helper 文案同源', () => {
    expect(storyStage).toContain('comic-story-planning-stage');
    expect(storyStage).toContain('comic-planning-recap-label">本期需求');
    expect(storyStage).toContain('title="AI 正在规划本期故事"');
    expect(storyStage.indexOf('comic-story-planning-stage'))
      .toBeLessThan(storyStage.indexOf('id="comic-story-requirement"'));
  });

  test('recap 摘要条样式存在（token 驱动，无新色值）', () => {
    expect(comicCss).toContain('.comic-planning-recap {');
    expect(comicCss).toContain('.comic-planning-recap-text {');
    const block = comicCss.slice(comicCss.indexOf('.comic-planning-recap {'), comicCss.indexOf('.comic-planning-surface {'));
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe('§43 故事审定 Story Hero 层级 + Replan 红线（§55）', () => {
  test('审定 = Story Hero：kicker → 标题 → chips → 故事主体（storyBody）→ 角色 → 按钮区', () => {
    // review JSX 框架顺序（kicker/title/chips 只在审定卡出现，位置唯一）
    const reviewStart = storyStage.indexOf("phase === 'review'");
    const frameOrder = [
      'comic-story-review-kicker',
      'comic-story-review-title',
      'comic-story-review-chips',
      '{storyBody(story)}',
      'comic-story-characters',
      'comic-story-review-actions',
    ] as const;
    for (let index = 1; index < frameOrder.length; index += 1) {
      expect(
        storyStage.indexOf(frameOrder[index], reviewStart),
        `${frameOrder[index - 1]} 应在 ${frameOrder[index]} 之前`,
      ).toBeGreaterThan(storyStage.indexOf(frameOrder[index - 1], reviewStart));
    }
    // 故事主体顺序（storyBody 单一定义处）：概要 → 节拍网格 → Punchline callout
    const bodyStart = storyStage.indexOf('const storyBody');
    const bodySlice = storyStage.slice(bodyStart, storyStage.indexOf('const storyHeroCard'));
    const bodyOrder = ['comic-story-review-summary', 'comic-story-beats', 'comic-story-punchline'] as const;
    for (let index = 1; index < bodyOrder.length; index += 1) {
      expect(
        bodySlice.indexOf(bodyOrder[index]),
        `${bodyOrder[index - 1]} 应在 ${bodyOrder[index]} 之前`,
      ).toBeGreaterThan(bodySlice.indexOf(bodyOrder[index - 1]));
    }
    expect(storyStage).toContain('确认这个故事');
  });

  test('不再是字段详情页：审定阶段无 comic-skill-facts dl；节拍不拼连续长文本', () => {
    expect(storyStage).not.toContain('comic-skill-facts');
    expect(storyStage).not.toContain(".join('　')");
    // 节拍逐格渲染为 <li>（不是 join 后的段落）
    expect(storyStage).toContain('value.beats.map((beat, index) => (');
    expect(storyStage).toContain('<li className="comic-story-beat"');
  });

  test('节拍网格列数几何同源：从 resolveComicPresentation 派生（四宫格 2 / 九宫格 3 / 竖排·多页 1）', () => {
    expect(resolveComicPresentation(skillOf('grid_4'), { totalPanels: 4 }).pages[0]!.columns).toBe(2);
    expect(resolveComicPresentation(skillOf('grid_9'), { totalPanels: 9 }).pages[0]!.columns).toBe(3);
    expect(resolveComicPresentation(skillOf('vertical_2'), { totalPanels: 2 }).pages[0]!.columns).toBe(1);
    expect(resolveComicPresentation(skillOf('horizontal_2'), { totalPanels: 2 }).pages[0]!.columns).toBe(2);
    expect(resolveComicPresentation(skillOf('multi_page'), { totalPanels: 4 }).pages[0]!.columns).toBe(1);
    expect(storyStage).toContain('repeat(${beatsColumns(value)}, minmax(0, 1fr))');
    expect(storyStage).toContain('const beatsColumns = (value: ComicStory): number =>');
  });

  test('Punchline callout：结尾类型徽标 + 最后一拍（visual 强调，不再是 dl 孤值）', () => {
    expect(storyStage).toContain('value.beats[value.beats.length - 1]');
    expect(storyStage).toContain('结尾 · {view.endingTypeLabel ?? value.endingType}');
    const block = comicCss.slice(comicCss.indexOf('.comic-story-punchline {'));
    expect(block).toContain('border-left: 2px solid var(--accent-primary)');
    expect(storyStage).toContain('data-testid="comic-story-punchline"');
  });

  test('审定按钮区：确认 = 唯一 Primary；重新描述 = secondary', () => {
    expect(storyStage).toContain('comic-story-review-actions');
    expect(storyStage).not.toContain('app-btn-primary app-btn-sm');
  });

  test('Replan 红线：规划中旧 Story 不清空——淡化 Hero 保留，失败仍可返回使用', () => {
    expect(storyStage).toContain('{project.story && storyHeroCard(project.story, true)}');
    expect(storyStage).toContain("comic-story-hero-faded' : 'comic-story-hero'");
    expect(storyStage).toContain('正在重新规划，失败后仍可返回使用');
    const block = comicCss.slice(comicCss.indexOf('.comic-story-hero-card.is-faded {'));
    expect(block).toContain('opacity');
    expect(block).toContain('pointer-events: none');
    // 规划失败只 patch run（不清 story / 不清 requirement；setStory(null) 只属于确认动作）
    const planBody = storyStage.slice(storyStage.indexOf('const runPlanStory'), storyStage.indexOf('const confirmStory'));
    expect(planBody).not.toContain('setStory(null)');
    expect(planBody).toContain("status: 'failed'");
    expect(storyStage).toContain('dismissLabel="返回修改需求"');
  });

  test('审定 / Hero 共用 storyBody 单实现（chips 用既有 pill 语言，不自建 tab）', () => {
    expect(storyStage).toContain('const storyBody = (value: ComicStory, options?: { skipSummary?: boolean })');
    expect(storyStage).toContain("storyBody(value, { skipSummary: true })");
    expect(storyStage).toContain('{storyBody(story)}');
    expect(comicCss).not.toContain('.comic-chip {');
    expect(comicCss).toContain('.comic-story-chip {');
  });
});
