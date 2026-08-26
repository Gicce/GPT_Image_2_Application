import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * Dimension Lock / Canonical Restore 页面接线源码契约（GUI 验收 Case B/C）：
 * 领域层纯函数已有专项测试；本文件锁定「页面确实接上了」——
 *  - 镜像 effect 依赖含 analysis（Case B 保存根因）；
 *  - 优化器输出过锁定清洗、越权可见（§21/§22）；
 *  - 生成前双门禁：合同校验 + 锁定校验（§20）；
 *  - 打开项目同步 hydrate（open→hydrate 竞态修复）；
 *  - Rail 锁标记（§30）。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const storeSrc = readFileSync(resolve(__dirname, '../../store/useVisualProjectStore.ts'), 'utf-8');
const railSrc = readFileSync(resolve(__dirname, '../../features/vision/project/ContextRail.tsx'), 'utf-8');
const planSrc = readFileSync(resolve(__dirname, '../../features/vision/project/effectivePlan.ts'), 'utf-8');

describe('Canonical Restore 接线（Case B）', () => {
  test('workspace → 项目镜像 effect 依赖包含 analysis / reverseResult / 任务关联', () => {
    const mirrorEffect = pageSrc.slice(
      pageSrc.indexOf('// workspace → 项目镜像'),
      pageSrc.indexOf('// 卸载时冲刷'),
    );
    expect(mirrorEffect).toContain('analysis,');
    expect(mirrorEffect).toContain('reverseResult,');
    expect(mirrorEffect).toContain('visionTaskId,');
    expect(mirrorEffect).toContain('sessionId,');
  });

  test('openProject 在 set(active) 之后同步调用 hydrateWorkspaceFromActive（消灭竞态窗口）', () => {
    const implStart = storeSrc.indexOf('openProject: async id =>');
    const persistIndex = storeSrc.indexOf('void persistProject(opened, true)', implStart);
    const openBlock = storeSrc.slice(implStart, persistIndex + 40);
    expect(openBlock).toContain("set({ active: opened, lastError: '' })");
    const setIndex = openBlock.indexOf('set({ active: opened');
    const hydrateIndex = openBlock.indexOf('get().hydrateWorkspaceFromActive()');
    expect(hydrateIndex).toBeGreaterThan(setIndex);
    expect(hydrateIndex).toBeLessThan(openBlock.indexOf('void persistProject(opened, true)'));
  });

  test('hydrateWorkspaceFromActive 使用 resolveRestoredAnalysis（快照重建兜底）', () => {
    expect(storeSrc).toContain('resolveRestoredAnalysis(current)');
    expect(storeSrc).toContain("stage: restoredAnalysis ? 'ready' : 'idle'");
  });

  test('重新分析路径把 workspace 快照传入 reapplyTemplateFromAnalysis', () => {
    const reapplyCall = pageSrc.slice(
      pageSrc.indexOf('reapplyTemplateFromAnalysis(draft'),
      pageSrc.indexOf('} else {', pageSrc.indexOf('reapplyTemplateFromAnalysis(draft')),
    );
    expect(reapplyCall).toContain('workspace: {');
    expect(reapplyCall).toContain('analysis: analysisSnapshot');
  });
});

describe('Dimension Lock 接线（Case C）', () => {
  test('优化器结果先过锁定清洗（applyOptimizationResult 携带 dimensionLocks）', () => {
    const applyBlock = pageSrc.slice(
      pageSrc.indexOf('applyOptimizationResult(optimizingState'),
      pageSrc.indexOf('const latest = useVisionWorkspaceStore.getState();'),
    );
    expect(applyBlock).toContain('dimensionLocks:');
    expect(applyBlock).toContain('lockedDimensionKeys(');
    expect(applyBlock).toContain('lockBaselineValues(');
  });

  test('优化器越权对用户可见（optimizerViolations toast）', () => {
    expect(pageSrc).toContain('next.optimizerViolations');
    expect(pageSrc).toContain('已忽略优化器对锁定维度的改动');
  });

  test('生成前双门禁：validateGenerationContract + validateDimensionLockContract', () => {
    const gateBlock = pageSrc.slice(
      pageSrc.indexOf('const contractErrors = validateGenerationContract'),
      pageSrc.indexOf('const personPath = personHasImage(currentDraft.person)'),
    );
    expect(gateBlock).toContain('validateDimensionLockContract(project)');
    expect(gateBlock).toContain('生成前需处理');
  });
});

describe('Rail 锁标记（§30：一眼看出什么会改）', () => {
  test('ContextRail 维度行渲染 🔒（沿用）/ ✦（修改）标记', () => {
    expect(railSrc).toContain("if (row.kind === 'keep') return '🔒 '");
    expect(railSrc).toContain("return '✦ '");
    expect(railSrc).toContain('DIMENSION_ROW_KEYS');
  });

  test('Effective Plan 含构图锁定行 + 锁定校验进入 blockingErrors', () => {
    expect(planSrc).toContain("key: 'composition'");
    expect(planSrc).toContain("label: '构图'");
    expect(planSrc).toContain('validateDimensionLockContract(project)');
  });
});
