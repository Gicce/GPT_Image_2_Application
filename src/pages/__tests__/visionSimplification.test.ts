import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * 视觉理解页简化工作流守卫（V4.0.9，源码文本断言，先例见 visionPlanUi.test.ts）：
 * - 详细视觉理解默认折叠（analysisOpen 初始 false）；
 * - 高级设置（Full Prompt / Negative Prompt / 生成方式 / 生成参数 / 高复刻）默认折叠；
 * - 修改意图是页面核心操作区；AI 方案默认自然语言，Prompt 编辑折叠；
 * - 视觉复刻默认图生图；评分详情折叠在 EvaluationPanel（不在页面平铺）；
 * - 生成结果区（Before / After + per-image 评价 + 继续调整）存在。
 */

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');

describe('默认折叠契约（V4.1：折叠 / Tab 全部迁移到 useVisionViewStore）', () => {
  test('详细视觉理解默认折叠：analysisDetailCollapsed 初始 true，summary 常驻', () => {
    expect(pageSrc).toContain('analysisDetailCollapsed');
    expect(pageSrc).toContain('vision-understanding-summary');
    expect(pageSrc).toContain('UNDERSTANDING.detailToggle');
  });

  test('高级设置默认折叠：advancedCollapsed 初始 true', () => {
    expect(pageSrc).toContain('advancedCollapsed');
    expect(pageSrc).toContain('ADVANCED_SETTINGS.title');
  });

  test('折叠 / Tab 是 View State：页面不再本地声明折叠 useState（禁止塞进业务对象）', () => {
    expect(pageSrc).not.toMatch(/const \[analysisOpen, setAnalysisOpen\]/);
    expect(pageSrc).not.toMatch(/const \[advancedOpen, setAdvancedOpen\]/);
    expect(pageSrc).not.toMatch(/const \[planFieldsOpen, setPlanFieldsOpen\]/);
    expect(pageSrc).not.toMatch(/const \[finalTab, setFinalTab\]/);
    expect(pageSrc).toContain('useVisionViewStore()');
  });

  test('原始 Prompt / Negative Prompt / 生成方式 / 生成参数全部在高级设置内（vision-advanced-body）', () => {
    const advancedBodyStart = pageSrc.indexOf('vision-advanced-body');
    const advancedSection = pageSrc.slice(advancedBodyStart);
    for (const marker of [
      '原始复刻 Prompt',
      'Negative Prompt',
      'vision-genmode',
      'vision-genparams',
      'EVALUATION_COPY.autoEvaluateLabel',
    ]) {
      expect(advancedSection).toContain(marker);
    }
  });

  test('AI 生成方案默认自然语言：最终 Prompt 编辑统一在 FinalPromptEditor（无第二套编辑区）', () => {
    expect(pageSrc).toContain('promptView');
    expect(pageSrc).toContain('vision-final-editor');
    expect(pageSrc).toContain('vision-plan-narrative');
    // 旧「编辑生成方案」第二套 Prompt 输入框已删除
    expect(pageSrc).not.toContain('planEditOpen');
    expect(pageSrc).not.toContain('AI_PLAN.editToggle');
  });

  test('维度锁定卡片同样默认折叠（dimensionsCollapsed 初始 true）', () => {
    expect(pageSrc).toContain('dimensionsCollapsed');
  });
});

describe('修改意图核心区（V4.1：结构化维度选择器）', () => {
  test('意图问题是页面核心标题 + 结构化 Chip 组件 + 自由文本聚焦行为', () => {
    expect(pageSrc).toContain('自定义修改内容');
    expect(pageSrc).toContain('ADJUST_INPUT.desc');
    expect(pageSrc).toContain('ModificationChips');
    expect(pageSrc).toContain('intentInputRef');
  });

  test('Chip 是结构化选择器：绝不向 textarea 追加文本（旧 append 协议已删除）', () => {
    expect(pageSrc).not.toContain('applyIntentChip');
    expect(pageSrc).not.toContain('INTENT_CHIPS');
    expect(pageSrc).toContain('toggleModificationDimension');
    expect(pageSrc).toContain('onFreeTextChange');
    // 自由文本绑定 draft.freeText（不是被 Chip 拼接的 adjustmentInput）
    expect(pageSrc).toMatch(/value=\{modificationDraft\.freeText\}/);
  });

  test('人物替换面板挂在 subject 维度下（结构化，不塞 textarea）', () => {
    expect(pageSrc).toContain('PersonReplacementPanel');
    expect(pageSrc).toContain("activeDimensions.includes('subject')");
  });

  test('分析中阶段使用 VisualAnalysisProgress（参考图反馈 + 文案轮播）', () => {
    expect(pageSrc).toContain('VisualAnalysisProgress');
    expect(pageSrc).toMatch(/\{wizardStep === 1 && stage === 'analyzing' && \(/);
  });
});

describe('视觉复刻默认图生图（Phase 4）', () => {
  test('生成方式选择收进高级设置，不再常驻主工作流', () => {
    // 主流程区块（vision-intent）内不包含生成方式切换
    const intentSection = pageSrc.slice(
      pageSrc.indexOf('vision-intent'),
      pageSrc.indexOf('vision-plan\"'),
    );
    expect(intentSection).not.toContain('vision-genmode-btn');
    // 生成方式在高级设置内保留（能力不删，只收进高级）
    expect(pageSrc).toContain('vision-genmode-btn');
    expect(pageSrc).toContain('GENERATION_MODE.i2iHint');
  });

  test('工作区默认 generationMode = i2i（carryApply 默认策略兜底）', () => {
    const workspaceSrc = readFileSync(resolve(__dirname, '../../store/useVisionWorkspaceStore.ts'), 'utf-8');
    expect(workspaceSrc).toMatch(/generationMode: 'i2i'/);
  });
});

describe('生成结果 + 评价闭环（Phase 12~17）', () => {
  test('生成结果区接入：Before / After + per-image 评价 + 继续调整回填', () => {
    expect(pageSrc).toContain('VisionResultSection');
    expect(pageSrc).toContain('onContinueAdjust={continueAdjustFromResult}');
    expect(pageSrc).toContain('continueAdjustFromResult');
  });

  test('评分详情不在页面平铺：六维明细只在 EvaluationPanel（features/evaluation）', () => {
    expect(pageSrc).not.toContain('instruction_adherence');
    expect(pageSrc).not.toContain('DIMENSION_LABELS');
  });

  test('自动评价开关在高级设置（用户可关闭 BYOK 自动调用）', () => {
    expect(pageSrc).toContain('toggleAutoEvaluate');
    expect(pageSrc).toContain('writeEvaluationSettings');
  });

  test('项目预览不常驻绝对路径：原图仍可进入查看器与所在目录', () => {
    const previewSrc = readFileSync(resolve(__dirname, '../../features/vision/project/ProjectPreviewPanel.tsx'), 'utf-8');
    expect(pageSrc).toContain('<ProjectPreviewPanel');
    expect(previewSrc).toContain('点击在内置图片查看器中查看');
    expect(previewSrc).toContain('onOpenFolder');
    expect(previewSrc).not.toContain('vision-source-path');
  });
});
