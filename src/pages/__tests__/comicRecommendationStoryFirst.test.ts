import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.2.7 AI 漫画推荐 Story-first + 可视化专项守卫。
 *
 * 锁定的规范（对应本轮验收清单 §四~§十五）：
 * - 布局可视化几何同源：grid_4=2×2 四格 / grid_9=3×3 九格 / vertical_2=上下 /
 *   horizontal_2=左右 / multi_page=逐页 1 张且带页数——全部走 resolveConceptPresentation
 *   （presentation.ts 单点计算），禁止推荐卡自己画第二套几何；
 * - 推荐预览零 Image API：预览组件纯 CSS/SVG（ComicFormPreviewMini / ComicStoryPreview），
 *   弹窗不 import 任何生图链路；
 * - Story 传递：选中方案 → buildStoryDraftFromConcept → uiDraft.story（phase=review），
 *   用户落地 Step 1「本期故事」即审定完整故事；
 * - Presentation 传递：concept.layout 确定性写入 skill.layout（服务层覆盖，不依赖 LLM）；
 * - 模型标识：推荐链路 resolveModelForRole 预显保持。
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf-8').replace(/\r\n/g, '\n');

const newProjectDialog = read('../../features/comic/components/ComicNewProjectDialog.tsx');
const formPreviewMini = read('../../features/comic/components/ComicFormPreviewMini.tsx');
const comicStudio = read('../ComicStudio.tsx');
const comicStore = read('../../store/useComicStore.ts');
const comicPlanner = read('../../services/comicPlanner.ts');

import { resolveConceptPresentation, comicPresentationLabel } from '../../features/comic/presentation';
import { buildStoryDraftFromConcept } from '../../features/comic/domain';
import type { ComicConcept } from '../../features/comic/types';

function conceptWith(layout: ComicConcept['layout']): Pick<ComicConcept, 'layout'> {
  return { layout };
}

describe('§四~§八 布局预览几何（resolveConceptPresentation 单点计算）', () => {
  test('grid_2x2（grid_4）：1 页 4 格 2 列', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 4, arrangement: 'grid_4' }));
    expect(p.pageCount).toBe(1);
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0]!.columns).toBe(2);
    expect(p.pages[0]!.panelOrders).toEqual([0, 1, 2, 3]);
  });

  test('grid_3x3（grid_9）：1 页 9 格 3 列', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 9, arrangement: 'grid_9' }));
    expect(p.pageCount).toBe(1);
    expect(p.pages[0]!.columns).toBe(3);
    expect(p.pages[0]!.panelOrders).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('vertical_2：上下双格（1 列 2 格）', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 2, arrangement: 'vertical_2' }));
    expect(p.pages[0]!.columns).toBe(1);
    expect(p.pages[0]!.panelOrders).toEqual([0, 1]);
  });

  test('horizontal_2：左右双格（2 列 2 格）', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 2, arrangement: 'horizontal_2' }));
    expect(p.pages[0]!.columns).toBe(2);
    expect(p.pages[0]!.panelOrders).toEqual([0, 1]);
  });

  test('vertical_strip（vertical_3）：竖排 3 格', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 3, arrangement: 'vertical_3' }));
    expect(p.pages[0]!.columns).toBe(1);
    expect(p.pages[0]!.panelOrders).toEqual([0, 1, 2]);
  });

  test('multi_page：4 页 · 每页 1 张 · 共 4 张图（不只是「多页模式」文字）', () => {
    const p = resolveConceptPresentation(conceptWith({ panelCount: 4, arrangement: 'multi_page', pageCount: 4 }));
    expect(p.outputMode).toBe('multi_page');
    expect(p.pageCount).toBe(4);
    expect(p.pages).toHaveLength(4);
    expect(p.pages.every(page => page.panelOrders.length === 1)).toBe(true);
    expect(comicPresentationLabel(p)).toBe('多页连载 · 4 页 · 每页 1 张 · 共 4 张图');
  });
});

describe('§十五 buildStoryDraftFromConcept（推荐故事 → 项目故事草稿）', () => {
  const concept: ComicConcept = {
    id: 'concept-a',
    name: '四格冷笑话',
    storyTitle: '《小鸭为什么不怕冷？》',
    oneLineStory: '冬天朋友问小鸭为什么不冷，小鸭说因为我自带羽绒服。',
    fullStory: '小鸭站在结冰的池塘边发呆。朋友问：你不冷吗？小鸭一本正经地说：因为我自带羽绒服。',
    punchline: '因为我自带羽绒服。',
    reason: '', comicForm: '四格漫画', visualStyle: '简笔', storyPattern: '', dialogueStyle: '',
    layout: { panelCount: 4, arrangement: 'grid_4' },
    characters: [{ name: '小鸭', role: '主角' }],
    storyboardBeats: [
      { order: 1, title: '冰面小鸭', summary: '小鸭站在结冰的池塘边', characters: ['小鸭'] },
      { order: 2, title: '朋友提问', summary: '朋友问你不冷吗', characters: [] },
      { order: 3, title: '小鸭回答', summary: '小鸭认真说不冷', characters: ['小鸭'] },
      { order: 4, title: '冷笑话', summary: '因为我自带羽绒服', characters: ['小鸭'] },
    ],
    tone: '冷幽默',
  };

  test('标题 / 一句话 / 完整故事 / 节拍 / 格数全部进入故事草稿', () => {
    const story = buildStoryDraftFromConcept(concept);
    expect(story.title).toBe('《小鸭为什么不怕冷？》');
    expect(story.topic).toBe(concept.oneLineStory);
    expect(story.summary).toBe(concept.fullStory);
    expect(story.beats).toEqual([
      '冰面小鸭：小鸭站在结冰的池塘边',
      '朋友提问：朋友问你不冷吗',
      '小鸭回答：小鸭认真说不冷',
      '冷笑话：因为我自带羽绒服',
    ]);
    expect(story.panelCount).toBe(4);
    expect(story.endingType).toBe('punchline');
    // 推荐预演不创建正式分镜/角色绑定
    expect(story.characterIds).toEqual([]);
  });

  test('无 punchline 回落 twist；storyTitle 缺省回落方案名', () => {
    const story = buildStoryDraftFromConcept({
      ...concept,
      storyTitle: '',
      punchline: '',
      storyboardBeats: [{ order: 1, title: '只有标题', summary: '', characters: [] }],
    });
    expect(story.title).toBe('四格冷笑话');
    expect(story.endingType).toBe('twist');
    expect(story.beats).toEqual(['只有标题']);
  });
});

describe('§九 推荐可视化零 Image API（不调 Image2 / 不产生计费）', () => {
  test('ComicFormPreviewMini：纯 CSS（无 <img> / 无 api / 无 invoke / 无生图 import）', () => {
    expect(formPreviewMini).not.toContain('<img');
    expect(formPreviewMini).not.toContain("from '../../../services/api'");
    expect(formPreviewMini).not.toContain('invoke(');
    for (const forbidden of ['comicTask', 'useTaskStore', 'billingService', 'createSeriesTask']) {
      expect(formPreviewMini.includes(forbidden), forbidden).toBe(false);
    }
  });

  test('新建弹窗：推荐阶段不 import 任何生图 / 任务 / 计费链路', () => {
    for (const forbidden of [
      "from '../../../features/comic/comicTask'",
      "from '../../../store/useTaskStore'",
      "from '../../../features/comic/generation'",
      'createSeriesTask',
      'comicCharacterImageClient',
    ]) {
      expect(newProjectDialog.includes(forbidden), forbidden).toBe(false);
    }
  });
});

describe('§十一/§十二 Story / Presentation 传递接线（源守卫）', () => {
  test('弹窗 → onCreate 携带 buildStoryDraftFromConcept(storyDraft + requirement)', () => {
    expect(newProjectDialog).toContain('buildStoryDraftFromConcept');
    expect(newProjectDialog).toContain('storyDraft: selectedConcept ? buildStoryDraftFromConcept(selectedConcept) : undefined');
  });

  test('页面 handleCreate 透传 storyDraft → createProject', () => {
    expect(comicStudio).toContain('storyDraft: input.storyDraft');
    expect(comicStudio).toContain('requirement: input.requirement');
  });

  test('store.createProject 种子 uiDraft.story（phase=review，进入即审定）', () => {
    expect(comicStore).toContain('uiDraft: storyDraft');
    expect(comicStore).toContain("phase: 'review'");
  });

  test('服务层确定性 Presentation 传递（concept.layout 覆盖 LLM 输出）', () => {
    expect(comicPlanner).toContain('skill.layout = { ...input.concept.layout }');
  });
});

describe('§十四 模型标识保持（推荐链路 resolveModelForRole）', () => {
  test('弹窗模型预显不回退', () => {
    expect(newProjectDialog).toContain("resolveModelForRole('comic_planner')");
    expect(newProjectDialog).toContain('modelLabel: resolution.resolved.displayName');
  });
});

describe('V4.2.7 §八 防重复提交与输入保留（GUI「日志 4 次」收口）', () => {
  test('推荐 / 技能起草均有 ref 同步双击防护：入口检查 → 请求前置位 → finally 释放', () => {
    // busy disabled 依赖下一次渲染，慢机上两次快速点击都能进入 handler；
    // ref 同步置位把窗口期归零（4 条 [AITransport] 日志 = 2 次点击 × initial+repair，
    // 而非一次点击 4 请求——requestId 日志已可区分）。
    for (const guard of ['recommendInFlight', 'draftSkillInFlight']) {
      expect(newProjectDialog).toContain(`if (${guard}.current) return;`);
      expect(newProjectDialog).toContain(`${guard}.current = true;`);
      expect(newProjectDialog).toContain(`${guard}.current = false;`);
    }
    // 置位发生在任何 await 之前（finally 释放保证失败后可重试）
    const recommendBody = newProjectDialog.slice(
      newProjectDialog.indexOf('const runRecommend'),
      newProjectDialog.indexOf('const runDraftSkill'),
    );
    expect(recommendBody.indexOf('recommendInFlight.current = true;'))
      .toBeLessThan(recommendBody.indexOf('await recommendComicConcepts'));
  });

  test('失败不清空用户输入：setRequirement(空串) 只出现在弹窗重开重置，不在请求链路里', () => {
    const resets = newProjectDialog.split("setRequirement('')");
    expect(resets).toHaveLength(2); // split 两段 = 全文件恰好 1 处清空调用
    // 该唯一清空点位于弹窗重开 useEffect(props.open) 内 —— 失败路径（runRecommend 的 outcome.ok=false /
    // catch）不触碰 requirement 状态，textarea 原文保留供用户重试或改写
    const effectBody = newProjectDialog.slice(
      newProjectDialog.indexOf('useEffect(() => {'),
      newProjectDialog.indexOf('if (!props.open) return null;'),
    );
    expect(effectBody).toContain("setRequirement('')");
    const recommendChain = newProjectDialog.slice(
      newProjectDialog.indexOf('const runRecommend'),
      newProjectDialog.indexOf('const createFromDraft'),
    );
    expect(recommendChain).not.toContain("setRequirement('')");
  });

  test('失败错误原位展示 + 重试入口：进度卡携带 errorText 与 onRetry', () => {
    expect(newProjectDialog).toContain('errorText: outcome.error');
    expect(newProjectDialog).toContain('retryLabel="重新推荐"');
    expect(newProjectDialog).toContain("onRetry={run.status === 'failed' ? () => void runRecommend() : undefined}");
  });
});
