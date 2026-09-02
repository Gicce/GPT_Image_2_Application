/**
 * V4.2.13 双问题修复 · 问题 1 SSR 真渲染断言（真实 React dispatcher）——
 * 仓库惯例（无 @testing-library / jsdom）：renderToStaticMarkup 组件级行为测试。
 * 与 directorHooksV4213.test.ts（迷你 dispatcher 序列模型）互补：本文件证明
 * 组件在真实 React 调度下 open=false / open=true 均无异常、输出完整且确定。
 *  - open=false → 空输出（常驻挂载零渲染负担）；
 *  - open=true → 完整弹窗：标题 / 副标题（零生图承诺）/ 四页签 / fill·panel·page
 *    三模式文案 / 生成建议入口；
 *  - 开合 ×3 输出逐字节稳定（无随机 key / 时间戳类抖动）；
 *  - fill 0 待补指引：全格已有对白 → 明确文案，渲染期零模型调用（验收 B）。
 */

import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// node 环境全局 stub（组件 open 渲染路径触达 document.body 与模型路由 store）
vi.stubGlobal('document', { body: {} });
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

// createPortal 直通：SSR 渲染 portal 内容本身（全部 hooks 在 createPortal 之前执行，
// mock 不影响 hooks 行为；node 无真实 DOM 容器）。
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createPortal: (children: unknown) => children };
});

import AIDialogueDirectorDialog, { type AIDialogueDirectorDialogProps } from '../components/AIDialogueDirectorDialog';
import { normalizeComicDialogue, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';

function makeProject(allFilled: boolean) {
  const skill = normalizeComicSkill({
    name: '双格技能',
    comicForm: '多格漫画',
    layout: { panelCount: 2, arrangement: 'vertical_2' },
    exportDefaults: { canvasRatio: '3:4', background: '#ffffff' },
    characterSlots: [],
  })!;
  const panels = [0, 1].map(order => normalizeComicPanel({
    id: `panel-${order}`,
    order,
    scene: `场景${order}`,
    generationStatus: 'completed',
    imageAsset: { path: `D:/lib/p${order}.png`, imageId: `img-${order}`, taskId: 't' },
  })!);
  const dialogues = allFilled
    ? [0, 1].map(order => normalizeComicDialogue({ id: `dlg-${order}`, panelId: `panel-${order}`, text: `已有对白${order}` })!)
    : [];
  return normalizeComicProject({
    id: 'p-ssr', name: '第一期', stage: 'editing',
    skillSnapshot: skill, characterSnapshots: [], characterBindings: {},
    panels, dialogues,
  })!;
}

function renderDirector(open: boolean, allFilled = false): string {
  const props: AIDialogueDirectorDialogProps = {
    open,
    project: makeProject(allFilled),
    onClose: () => {},
    onApplyProposals: () => {},
    onApplyPlacement: () => {},
    onSubmitBakeText: () => {},
    bakeSubmitting: false,
  };
  return renderToStaticMarkup(createElement(AIDialogueDirectorDialog, props));
}

describe('问题 1：真实 React dispatcher 渲染（开合无崩溃）', () => {
  it('open=false → 空输出（常驻挂载，关闭即零负担）', () => {
    expect(renderDirector(false)).toBe('');
  });

  it('open=true → 完整弹窗（标题 / 零生图副标题 / 四页签 / 三模式 / 生成建议入口）', () => {
    const markup = renderDirector(true);
    expect(markup).toContain('AI 对白导演');
    expect(markup).toContain('所有建议确认后才写入，普通编辑零生图');
    expect(markup).toContain('AI 规划对白');
    expect(markup).toContain('视觉理解排版');
    expect(markup).toContain('一键排对白');
    expect(markup).toContain('烘焙文字（实验）');
    expect(markup).toContain('只补空白格（推荐 · 不改已有文字）');
    expect(markup).toContain('重新生成本格对白');
    expect(markup).toContain('重新生成整页对白（覆盖现有）');
    expect(markup).toContain('生成对白建议');
  });

  it('开合 ×3：无异常且输出逐字节稳定', () => {
    const first = renderDirector(true);
    for (const open of [false, true, false, true]) {
      expect(renderDirector(open)).toBe(open ? first : '');
    }
  });
});

describe('验收 B：fill 0 待补指引（渲染期零模型调用）', () => {
  it('全格已有对白 → 提示换模式，不再出现「还有 N 格」', () => {
    const markup = renderDirector(true, true);
    expect(markup).toContain('所有格都已有对白——请换「重新生成本格」或「重新生成整页」');
    expect(markup).not.toContain('还有 ');
  });

  it('存在空白格 → 显示待补数量', () => {
    expect(renderDirector(true)).toContain('还有 2 格');
  });
});
