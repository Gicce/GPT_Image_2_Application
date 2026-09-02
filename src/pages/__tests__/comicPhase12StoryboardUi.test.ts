import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画分镜阶段 UI 接线源守卫（Phase 1.2 §37~§40 + V4.2.11 §E 排版直出）。
 *
 * 锁定的规范：
 * - §37 步骤副标题「AI 已把故事拆成每一格要画什么」；
 * - V4.2.11 §E（P0-5）：分镜直接按最终排版呈现——comic-storyboard-grid 按
 *   presentation 页几何摆格（四宫格 = 2 列 4 格），未规划格位 = 等待规划占位；
 *   0 分镜时按 skill.layout.panelCount 画完整版式骨架，不再是巨大空白单图；
 * - §38 分镜格卡字段分层（第N格 / 标题 / 场景摘要 / 主要角色 / 动作 / 表情 / 对白概要），
 *   §38.1 Prompt 不默认展示（已应用格折叠「高级 · 生成详情」）；
 * - §38.2 大白话改单格：patchComicPanel 白名单补丁 → applyComicPanelPatches →
 *   草稿态改草稿 / 已应用走 onPatch（页面层 applyProject），只动那一格；
 *   微调输入防抖写穿 uiDraft.storyboard.patchTexts（§30/§85 刷新不丢）；
 * - §40 多页模式按「第 N 页」分组，不再全部平铺；
 * - 整体重出 = 重新规划本期版式（按 presentation.name 动态文案）；
 * - V4.2.11 §D（P0-6）：CTA 不出现「第一张」锚点语言。
 */

const page = readFileSync(resolve(__dirname, '../ComicStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const stage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicStoryboardStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('§37 分镜阶段头', () => {
  test('副标题 = AI 已把故事拆成每一格要画什么（带本期标题）', () => {
    expect(stage).toContain('AI 已把故事「{story.title}」拆成每一格要画什么');
  });
});

describe('V4.2.11 §E 排版直出（P0-5 硬验收）', () => {
  test('分镜卡落在排版网格上：gridTemplateColumns 同源 presentation 页几何', () => {
    expect(stage).toContain('className="comic-storyboard-grid"');
    expect(stage).toContain('gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`');
    expect(stage).toContain('data-testid="comic-storyboard-grid"');
    expect(stage).toContain('data-columns={columns}');
  });

  test('0 分镜时按计划格数画完整版式骨架（不再回落成单格空白大图）', () => {
    expect(stage).toContain('const plannedTotal = skill.layout.panelCount > 0 ? skill.layout.panelCount : listPanels.length;');
    expect(stage).toContain('totalPanels: Math.max(plannedTotal, listPanels.length, 1)');
  });

  test('未规划格位 = 等待规划占位卡', () => {
    expect(stage).toContain('comic-panel-card is-pending');
    expect(stage).toContain('等待规划');
    expect(stage).toContain('data-testid={`comic-panel-pending-${order}`}');
    // 每个格位都有归属：有分镜渲染分镜卡，缺格渲染占位
    expect(stage).toContain('return panel ? renderPanelCard(panel) : renderPendingCell(order);');
  });

  test('标题字段来自 story.beats（节拍 → 格标题）', () => {
    expect(stage).toContain('const beatTitle = story?.beats?.[panel.order] ?? \'\'');
    expect(stage).toContain('{beatTitle && <div><dt>标题</dt><dd>{beatTitle}</dd></div>}');
  });
});

describe('§38 分镜格卡字段分层 + 生成详情折叠', () => {
  test('标签行：场景摘要 / 主要角色 / 动作 / 表情 / 对白概要（dt/dd 语义化）', () => {
    expect(stage).toContain('<dt>场景摘要</dt>');
    expect(stage).toContain('<dt>主要角色</dt>');
    expect(stage).toContain('<dt>动作</dt>');
    expect(stage).toContain('<dt>表情</dt>');
    expect(stage).toContain('<dt>对白概要</dt>');
    expect(stage).toContain('第 {panel.order + 1} 格');
  });

  test('§38.1 最终 Prompt 不默认展示：仅已应用格 + 有 compiledPrompt 才渲染折叠', () => {
    expect(stage).toContain('{!showingDraft && panel.compiledPrompt && (');
    expect(stage).toContain('高级 · 生成详情');
    expect(stage).toContain('comic-panel-advanced');
    // 旧平铺行结构已退场
    expect(stage.includes('comic-storyboard-row')).toBe(false);
    expect(stage.includes('comic-storyboard-main')).toBe(false);
    // 旧「顶部缩略示意 + 平铺列表」结构已退场（§E 排版直出取代）
    expect(stage.includes('comic-storyboard-list')).toBe(false);
    expect(stage.includes('格位示意')).toBe(false);
  });
});

describe('§38.2 大白话改单格', () => {
  test('服务调用 + 领域应用链：patchComicPanel → applyComicPanelPatches → 草稿/项目双路径', () => {
    expect(stage).toContain("import { draftStoryboard, patchComicPanel } from '../../../services/comicPlanner'");
    expect(stage).toContain('await patchComicPanel({ panel, instruction: text })');
    expect(stage).toContain('applyComicPanelPatches(panel, outcome.patches)');
    // 草稿态：改分镜草稿本体
    expect(stage).toContain('panels: draft.panels.map(item => (item.id === panel.id ? application.panel : item))');
    // 已应用：走 onPatch（页面层 applyProject → replaceProjectPanel）
    expect(stage).toContain('props.onPatch(projectDraft => replaceProjectPanel(projectDraft, application.panel))');
  });

  test('空指令 / 未命中字段有就地反馈（不静默失败）', () => {
    expect(stage).toContain('请先填写这一格的修改要求');
    expect(stage).toContain('本次调整没有命中可修改的字段，请换一种说法');
  });

  test('微调输入防抖写穿 uiDraft.storyboard.patchTexts（§30/§85）', () => {
    expect(stage).toContain('useDebouncedDraftValue<Record<string, string>>');
    expect(stage).toContain('project.uiDraft?.storyboard?.patchTexts ?? {}');
    expect(stage).toContain('patchTexts: kept');
    // 应用 / 重出剥离草稿本体时，未用完的单格输入保留
    expect(stage).toContain('storyboard: { patchTexts: draftState.storyboard?.patchTexts }');
  });

  test('页面层接线：onPatch 走 applyProject（语义更新统一入口）', () => {
    expect(page).toContain('<ComicStoryboardStage project={active} onApply={handleApplyStory} onPatch={applyProject} onPanelMove={handlePanelMove} onDraft={handleDraft} />');
  });
});

describe('§40 多页分组 + 整体重出', () => {
  test('多页模式按 presentation.pages 分组（第 N 页标题），映射不齐回落补充格', () => {
    expect(stage).toContain('presentation.pages.length > 1');
    expect(stage).toContain('第 {page.pageIndex + 1} 页');
    expect(stage).toContain('comic-storyboard-page');
    expect(stage).toContain('page.panelOrders');
    expect(stage).toContain('补充格');
  });

  test('整体重出按钮按 presentation.name 动态（重新规划四宫格…）', () => {
    expect(stage).toContain('const replanLabel = `重新规划${presentation.name}`');
    expect(stage).toContain('{showingDraft || panels.length > 0 ? replanLabel : \'生成分镜草稿\'}');
  });

  test('应用 CTA 不出现「第一张」锚点语言（V4.2.11 §D P0-6）', () => {
    expect(stage).toContain('应用分镜，去生成漫画画面');
    expect(stage).not.toContain('第一张');
  });
});

describe('copy.md 术语登记', () => {
  test('新增 UI 文案已登记（2a：新中文 UI 术语必须注册）', () => {
    for (const term of [
      '只改这一格', '高级 · 生成详情', '等待规划', '场景摘要', '主要角色',
      '重新规划四宫格 / 重新规划九宫格…', '应用分镜，去生成漫画画面',
    ]) {
      expect(copy.includes(term)).toBe(true);
    }
  });
});
