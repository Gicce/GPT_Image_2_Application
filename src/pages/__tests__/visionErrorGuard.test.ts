import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 视觉理解 UI Error Guard（V4.0.9，源码文本断言，先例见 visionSimplification.test.ts）：
 * - Internal transport / parser / schema errors MUST NEVER be exposed directly in user-facing UI；
 * - 失败文案统一经 mapVisionErrorToUserMessage 映射（禁止裸渲染 error_message）；
 * - 重新理解失败保留上一次成功分析（不改写为空状态）；
 * - 修复过程用户无感：VisualAnalysisProgress 不回退为纯 Spinner。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const errorsSrc = readFileSync(resolve(__dirname, '../../features/vision/visionErrors.ts'), 'utf-8');

describe('错误映射强制接入', () => {
  test('页面接入 mapVisionErrorToUserMessage（runAnalysis 失败 / catch / 高复刻失败三处）', () => {
    expect(pageSrc).toContain("from '../features/vision/visionErrors'");
    const uses = pageSrc.match(/mapVisionErrorToUserMessage\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  test('禁止把 error_message 裸渲染进失败态（旧链路已删除）', () => {
    expect(pageSrc).not.toContain("result.error_message || '结构化分析返回格式无效'");
    expect(pageSrc).not.toMatch(/markStage\('failed', `视觉理解失败：\$\{message\}`\)/);
  });

  test('错误映射层声明两条强制规则（拦截 + 隐藏不是恢复）', () => {
    expect(errorsSrc).toContain('MUST NEVER be exposed directly');
    expect(errorsSrc).toContain('Hiding an error message is NOT error recovery');
    expect(errorsSrc).toMatch(/isTechnicalErrorMessage/);
  });
});

describe('重新理解失败保留旧结果', () => {
  test('失败分支读取 hadPreviousAnalysis 并提示「仍保留上一次分析结果」', () => {
    expect(pageSrc).toContain('hadPreviousAnalysis');
    expect(pageSrc).toContain('仍保留上一次分析结果');
  });

  test('失败后入口仍可用：主入口按钮不被 error state 永久禁用（busy 只看 analyzing/running）', () => {
    expect(pageSrc).toMatch(/const busy = stage === 'analyzing' \|\| running/);
    expect(pageSrc).not.toMatch(/disabled=\{busy \|\| stage === 'failed'\}/);
  });
});

describe('修复过程用户无感（VisualAnalysisProgress 保持）', () => {
  test('分析阶段继续使用创意文案轮播组件（不回退纯 Spinner）', () => {
    expect(pageSrc).toContain('VisualAnalysisProgress');
    expect(pageSrc).toMatch(/\{stage === 'analyzing' && \(/);
    expect(pageSrc).not.toContain('正在修复');
    expect(pageSrc).not.toContain('重新解析');
  });
});
