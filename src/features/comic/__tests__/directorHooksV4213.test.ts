/**
 * V4.2.13 双问题修复 · 问题 1 组件级生命周期测试（AI 对白导演 Hooks 崩溃）。
 *
 * 根因（修复前）：4 个 auto useState（autoPhase / autoProposals / autoVisionPanels /
 * autoVisionApplied）声明在 `if (!props.open) return null;` 早退之后——组件常驻挂载
 * （ComicStudio `{active && <AIDialogueDirectorDialog open={directorOpen} …/>}`，
 * open=false 也完整执行组件函数 = 17 hooks），首次打开渲染 21 hooks → React 抛
 * "Rendered more hooks than during the previous render"，页面崩溃。
 *
 * 本仓库 vitest 无 jsdom（node 环境，无状态化渲染器 / @testing-library），这里用
 * vi.mock('react') 装载「迷你 hooks dispatcher」：跨 render 保持槽位值并记录调用
 * 序列——它建模的正是 React 规则「hooks 仅按调用顺序识别，跨渲染序列必须一致」。
 * 序列在 open 翻转 / 状态混沌 / StrictMode 双调用下逐项相等 = 崩溃根因已消除。
 * 配套源守卫：组件内全部 hooks 声明必须位于早退之前（15 useState + 1 useRef +
 * 5 useMemo = 21）。SSR 真实 React dispatcher 的完整渲染断言见
 * directorDialogRenderV4213.test.ts。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';

// node 环境全局 stub：open=true 渲染路径触达 document.body（createPortal 容器实参）
// 与模型路由 store 的 localStorage（resolveModelForRole 只读预显）。
vi.stubGlobal('document', { body: {} });
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
});

interface HooksProbeState {
  slots: unknown[];
  seq: string[];
  cursor: number;
}

interface HooksProbe {
  state: HooksProbeState;
  beginRender(): void;
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const state: HooksProbeState = { slots: [], seq: [], cursor: 0 };
  const useState = (initial?: unknown): [unknown, () => void] => {
    const index = state.cursor++;
    state.seq.push('useState');
    if (!(index in state.slots)) {
      state.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    return [state.slots[index], () => undefined];
  };
  const useRef = (initial?: unknown): { current: unknown } => {
    const index = state.cursor++;
    state.seq.push('useRef');
    if (!(index in state.slots)) state.slots[index] = { current: initial };
    return state.slots[index] as { current: unknown };
  };
  const useMemo = (factory: () => unknown): unknown => {
    const index = state.cursor++;
    state.seq.push('useMemo');
    if (!(index in state.slots)) state.slots[index] = factory();
    return state.slots[index];
  };
  const useCallback = (callback: unknown): unknown => {
    const index = state.cursor++;
    state.seq.push('useCallback');
    if (!(index in state.slots)) state.slots[index] = callback;
    return state.slots[index];
  };
  const probe: HooksProbe = {
    state,
    beginRender() {
      state.cursor = 0;
      state.seq = [];
    },
  };
  return { ...actual, useState, useRef, useMemo, useCallback, __hooksProbe: probe };
});

// createPortal 直通（node 无 DOM）。全部 hooks 在 return createPortal(...) 之前执行，
// 此 mock 不可能遮蔽 hooks 顺序问题。
vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createPortal: (children: unknown) => children };
});

import AIDialogueDirectorDialog, { type AIDialogueDirectorDialogProps } from '../components/AIDialogueDirectorDialog';
import { normalizeComicDialogue, normalizeComicPanel, normalizeComicProject, normalizeComicSkill } from '../normalize';

const probe = (React as unknown as { __hooksProbe: HooksProbe }).__hooksProbe;

const source = readFileSync(
  resolve(__dirname, '../components/AIDialogueDirectorDialog.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');

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
    id: 'p-hooks', name: '第一期', stage: 'editing',
    skillSnapshot: skill, characterSnapshots: [], characterBindings: {},
    panels, dialogues,
  })!;
}

function baseProps(open: boolean, project = makeProject(false)): AIDialogueDirectorDialogProps {
  return {
    open,
    project,
    onClose: () => {},
    onApplyProposals: () => {},
    onApplyPlacement: () => {},
    onSubmitBakeText: () => {},
    bakeSubmitting: false,
  };
}

function renderDirector(open: boolean, project = makeProject(false)): string[] {
  probe.beginRender();
  const output = AIDialogueDirectorDialog(baseProps(open, project));
  // open=false → null（早退）；open=true → portal 直通 JSX
  if (open) expect(output).not.toBeNull();
  else expect(output).toBeNull();
  return [...probe.state.seq];
}

describe('问题 1：hook 序列跨渲染稳定（修复前 open=true 比 open=false 多 4 个 useState）', () => {
  it('open=false 与 open=true 序列逐项相等；总量 21 = 15 useState + 1 useRef + 5 useMemo', () => {
    const closedSeq = renderDirector(false);
    const openSeq = renderDirector(true);
    expect(openSeq).toEqual(closedSeq);
    expect(closedSeq).toHaveLength(21);
    expect(closedSeq.filter(name => name === 'useState')).toHaveLength(15);
    expect(closedSeq.filter(name => name === 'useRef')).toHaveLength(1);
    expect(closedSeq.filter(name => name === 'useMemo')).toHaveLength(5);
  });

  it('开合 ×3 交替（常驻挂载语义）序列恒定', () => {
    const baseline = renderDirector(false);
    for (const open of [true, false, true, false, true, false]) {
      expect(renderDirector(open)).toEqual(baseline);
    }
  });

  it('StrictMode 双调用等价：同 props 连续两次渲染序列一致（确定性重渲染）', () => {
    const first = renderDirector(true);
    const second = renderDirector(true);
    expect(second).toEqual(first);
  });

  it('状态混沌重渲染：tab/mode/autoPhase 等任意状态值组合都不得改变 hook 序列', () => {
    const baseline = renderDirector(true);
    // 字符串槽轮换到每个页签值（含崩溃场景所在的 auto 页签）+ 越界值；
    // 数字槽越界、布尔槽全真——渲染分支最大化展开，hooks 数必须不变。
    for (const replacement of ['auto', 'vision', 'plan', 'bake', 'page']) {
      probe.state.slots.forEach((value, index) => {
        if (typeof value === 'string') probe.state.slots[index] = replacement;
        else if (typeof value === 'number') probe.state.slots[index] = 99;
        else if (typeof value === 'boolean') probe.state.slots[index] = true;
      });
      expect(renderDirector(true)).toEqual(baseline);
    }
  });

  it('fill 0 待补指引分支（全格已有对白）不改变 hook 序列', () => {
    const baseline = renderDirector(true);
    expect(renderDirector(true, makeProject(true))).toEqual(baseline);
  });
});

describe('问题 1 源守卫：全部 hooks 声明位于 `if (!props.open)` 早退之前', () => {
  const marker = 'if (!props.open) return null;';
  const splitAt = source.indexOf(marker);

  it('早退标记存在且唯一', () => {
    expect(splitAt).toBeGreaterThan(0);
    expect(source.indexOf(marker, splitAt + 1)).toBe(-1);
  });

  it('早退之前：15 useState / 1 useRef / 5 useMemo；早退之后：0（新增 hook 必须上移）', () => {
    const before = source.slice(0, splitAt);
    const after = source.slice(splitAt + marker.length);
    expect(before.match(/const \[[a-zA-Z]+, set[A-Z][a-zA-Z]*\] = useState/g)).toHaveLength(15);
    expect(before.match(/useRef</g)).toHaveLength(1);
    expect(before.match(/useMemo\(\(\) =>/g)).toHaveLength(5);
    expect(after.match(/const \[[a-zA-Z]+, set[A-Z][a-zA-Z]*\] = useState/g)).toBeNull();
    expect(after.match(/useRef</g)).toBeNull();
    expect(after.match(/useMemo\(\(\) =>/g)).toBeNull();
  });
});
