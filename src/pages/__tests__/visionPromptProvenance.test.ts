import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 视觉理解页「最终生图 Prompt」Provenance 守卫（V4.1，源码文本断言先例见 visionPlanUi.test.ts）：
 * - 页面显示的 finalPrompt 与「确认生成图片」提交值必须是同一来源（promptDraft）；
 * - FinalPromptEditor 是唯一 Prompt 编辑器（最终版本 / 修改对比两态，无第二套「编辑生成方案」）；
 * - 优化失败不清空上一次成功 Prompt，提供「使用上一次 Prompt」回退；
 * - 维度 Diff（原 / 新红绿对比）与全文 Diff（+/- 前缀 + 删除线）存在；
 * - 参考图 / 生成结果接入全局内置 ImageViewer。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const css = readFileSync(resolve(__dirname, '../VisionUnderstanding.css'), 'utf-8');
const resultSrc = readFileSync(
  resolve(__dirname, '../../features/evaluation/VisionResultSection.tsx'),
  'utf-8',
);

describe('Prompt Provenance：显示值 === 提交值', () => {
  test('finalPrompt 唯一来源 = promptDraft（提交侧分层：非项目 = 原文；项目 = Compiler 编译）', () => {
    expect(pageSrc).toMatch(/const finalPrompt = promptDraft\.trim\(\)/);
    // V4.1 Workbench V2：项目化链路经 Prompt Compiler 编译后提交（finalPromptText），
    // 非项目链路（无 activeProject）保持 promptDraft.trim() 原文直提 —— 两种路径
    // 都从同一 finalDescription（promptDraft）出发，绝不引入第二个人工编辑源。
    expect(pageSrc).toMatch(/let finalPromptText = promptDraft\.trim\(\)/);
    expect(pageSrc).toMatch(/finalDescription: promptDraft\.trim\(\)/);
    expect(pageSrc).toMatch(/optimizedPrompt: finalPromptText/);
    expect(pageSrc).toContain('promptCompiled');
  });

  test('FinalPromptEditor 存在（标题 / 状态 / 最终版本 / 修改对比 / 复制）', () => {
    expect(pageSrc).toContain('FINAL_PROMPT.title');
    expect(pageSrc).toContain('FINAL_PROMPT.tabFinal');
    expect(pageSrc).toContain('FINAL_PROMPT.tabDiff');
    expect(pageSrc).toContain('FINAL_PROMPT.copyLabel');
    expect(pageSrc).toContain('FINAL_PROMPT.desc');
    for (const state of ['statusReady', 'statusManual', 'statusDirty', 'statusFailed', 'useLastButton']) {
      expect(pageSrc).toContain(`FINAL_PROMPT.${state}`);
    }
    expect(css).toContain('.vision-final-prompt');
    expect(css).toContain('.vision-final-editor');
  });

  test('页面只有一个 Prompt 编辑器：promptDraft 的 textarea 仅出现一次', () => {
    // 编辑 FinalPromptEditor → promptDraft（onChange 单一入口）
    const editorMatches = pageSrc.match(/value=\{promptDraft\}/g) || [];
    expect(editorMatches).toHaveLength(1);
    expect(pageSrc).toContain('onChange={e => editFinalPrompt(e.target.value)}');
    expect(pageSrc).toContain('fullPromptOverride: value');
    // 旧「编辑生成方案」第二套 UI（独立折叠 + textarea）已彻底删除
    expect(pageSrc).not.toContain('编辑生成方案');
    expect(pageSrc).not.toContain('vision-plan-edit');
    expect(pageSrc).not.toContain('vision-final-text');
  });

  test('Final View / Diff View 同一空间切换：promptView 二态（View State store）+ Diff 不再是第二个输入框', () => {
    expect(pageSrc).toContain("view.setPromptView('final')");
    expect(pageSrc).toContain("view.setPromptView('diff')");
    expect(pageSrc).toContain('useVisionViewStore');
    // 同一卡片内 ternary 切换：最终版本 = textarea，修改对比 = diff segments
    expect(pageSrc).toContain("promptView === 'final' ? (");
    // Diff 视图渲染 diff segment（不是第二个 textarea）
    const diffBranch = pageSrc.slice(
      pageSrc.indexOf('<p className="vision-diff-body">'),
      pageSrc.indexOf('vision-final-actions'),
    );
    expect(diffBranch).toContain('fullPromptDiff.segments.map');
    expect(diffBranch).not.toContain('<textarea');
    // 整页只有一个绑定 promptDraft 的编辑器
    expect(pageSrc.match(/value=\{promptDraft\}/g)).toHaveLength(1);
  });

  test('手动修改状态：FinalPromptEditor 编辑后不再显示「最终 Prompt 已生成」', () => {
    const map = pageSrc.slice(
      pageSrc.indexOf('finalPromptStatus = useMemo'),
      pageSrc.indexOf('const fullPromptDiff'),
    );
    expect(map).toContain("'dirty' && recreation.optimizeError");
    expect(map).toContain("'dirty'");
    expect(map).toContain("'manual'");
    expect(map).toContain("'generated'");
  });

  test('优化失败可回退：revertToLastSuccessfulPrompt + 状态栏外 CTA', () => {
    expect(pageSrc).toContain('revertToLastSuccessfulPrompt');
    expect(pageSrc).toContain('useLastSuccessfulPrompt');
    // CTA 在 Banner 外（vision-status-row 包裹，不进 vision-status-bar）
    const row = pageSrc.slice(
      pageSrc.indexOf('vision-status-row'),
      pageSrc.indexOf('vision-plan-actions'),
    );
    expect(row).toContain('vision-status-bar');
    expect(row).toContain('FINAL_PROMPT.useLastButton');
  });
});

describe('Prompt Diff（维度 Diff + 全文 Diff）', () => {
  test('全文 Diff：computePromptDiff + +/- 前缀 + 删除线类（不只靠颜色）', () => {
    expect(pageSrc).toContain('computePromptDiff');
    expect(pageSrc).toContain('diff-seg diff-added');
    expect(pageSrc).toContain('diff-seg diff-removed');
    expect(css).toContain('.diff-seg.diff-added');
    expect(css).toContain('.diff-seg.diff-removed');
    expect(css).toContain('text-decoration: line-through');
  });

  test('Diff 颜色来自 --diff-* 语义 Token（light/dark 均定义）', () => {
    const appCss = readFileSync(resolve(__dirname, '../../App.css'), 'utf-8');
    for (const token of ['--diff-added', '--diff-added-bg', '--diff-removed', '--diff-removed-bg']) {
      expect(appCss).toMatch(new RegExp(`${token}\\s*:`));
    }
    // 两个主题块都定义（出现次数 ≥ 2）
    expect((appCss.match(/--diff-added:/g) || []).length).toBeGreaterThanOrEqual(2);
    expect((appCss.match(/--diff-removed:/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('维度卡：已修改态 + 原/新对比（dimensionDiff）', () => {
    expect(pageSrc).toContain('dimensionDiff');
    expect(pageSrc).toContain("DIMENSION_LOCK.changed");
    expect(pageSrc).toContain('DIMENSION_LOCK.oldValuePrefix');
    expect(pageSrc).toContain('DIMENSION_LOCK.newValuePrefix');
    expect(css).toContain('.vision-lock-badge.is-changed');
    expect(css).toContain('.vision-field-diff');
  });

  test('维度锁定来源区分：AI 判断 vs 用户手动（user_override 优先）', () => {
    expect(pageSrc).toContain("field.lockSource === 'user_override'");
    expect(pageSrc).toContain('DIMENSION_LOCK.manualSuffix');
    expect(pageSrc).toContain('DIMENSION_LOCK.userLabel');
    expect(pageSrc).toContain('DIMENSION_LOCK.aiLabel');
  });
});

describe('WorkflowStatusBanner（状态栏图标通道）', () => {
  test('状态点 + 标签 + 引导语三元素（不只靠背景色）', () => {
    expect(pageSrc).toContain('vision-status-dot');
    expect(css).toContain('.vision-status-dot');
    for (const tone of ['gray', 'green', 'orange', 'blue', 'red']) {
      expect(css).toContain(`.vision-status-bar.tone-${tone} .vision-status-dot`);
    }
  });
});

describe('内置 ImageViewer 接入（视觉理解页）', () => {
  test('参考图点击进入全局查看器（cursor zoom-in）', () => {
    expect(pageSrc).toContain('useImageViewerStore');
    expect(pageSrc).toContain('openViewer');
    expect(css).toContain('.vision-source-img');
    expect(css).toMatch(/\.vision-source-img\s*{[^}]*cursor:\s*zoom-in/);
  });

  test('生成结果：缩略图点击进查看器（选中态保留）+ 评价跟随选中图，页面无重复大图', () => {
    expect(resultSrc).toContain('vision-result-quick');
    expect(resultSrc).toContain('openViewerAt');
    expect(resultSrc).toContain('vision-result-favorite');
    expect(resultSrc).toContain('setFavorite');
    expect(resultSrc).toContain('submittedPromptOf');
    // 评价面板跟随选中缩略图
    expect(resultSrc).toContain('vision-result-eval');
    expect(resultSrc).toContain('selectedAssetId');
    // 页面内不再渲染 SelectedResult 大图（stage 已删除，看大图统一进全局 Viewer）
    expect(resultSrc).not.toContain('vision-result-stage');
    expect(resultSrc).not.toContain('vision-result-detail');
    // 点击缩略图 = 选中 + 进入查看器（评价随选中切换）
    expect(resultSrc).toMatch(/setSelectedAssetId\(item\.assetId\); openViewerAt\(item\.assetId\)/);
  });
});

describe('§33 Prompt Truth Source（本轮再确认：Final = Confirm = Submitted = History）', () => {
  test('生成链路单次编译：mergeFinalGenerationPrompt 输出直进 carry（无二次 compile 漂移）', () => {
    // 生成路径（generateFromPlan）只在一处调用 mergeFinalGenerationPrompt，
    // compiled.prompt 原样赋值 finalPromptText → carry.optimizedPrompt
    const generationPath = pageSrc.slice(
      pageSrc.indexOf('let finalPromptText = promptDraft.trim()'),
      pageSrc.indexOf('const carry = buildGenerationCarry'),
    );
    expect(generationPath.match(/mergeFinalGenerationPrompt\(/g)?.length).toBe(1);
    expect(generationPath).toContain('finalPromptText = compiled.prompt');
    expect(generationPath).toContain('finalNegativeText = compiled.negativePrompt');
    // 实况预览（openPromptSource）与生成编译互不影响：预览不写任何提交状态
    const previewPath = pageSrc.slice(
      pageSrc.indexOf('const openPromptSource'),
      pageSrc.indexOf('setSkillTraceMode(\'prompt\')'),
    );
    expect(previewPath).not.toContain('setPromptDraft');
    expect(previewPath).not.toContain('finalPromptText');
  });

  test('carry 冻结 compiled prompt（promptCompiled=true 时 ImageStudio 不再二次前置指令）', () => {
    expect(pageSrc).toMatch(/promptCompiled,/);
    expect(pageSrc).toMatch(/optimizedPrompt: finalPromptText/);
  });
});
