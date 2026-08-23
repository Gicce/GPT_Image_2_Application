import { describe, it, expect } from 'vitest';
import {
  ADJUST_INPUT,
  AI_PLAN,
  ANALYSIS_PROGRESS,
  CLOTHING_POLICY,
  EVALUATION_COPY,
  GENERATE_DIALOG,
  GENERATION_PARAMS,
  MODIFICATION_CHIPS,
  NO_USABLE_VISION_MODEL,
  OPTIMIZE_TOAST,
  PERSON_REPLACEMENT,
  REOPTIMIZE_ACTION,
  RESTART_ACTION,
  UNDERSTANDING,
  getVisualAnalysisMessage,
  optimizeFailureMessage,
} from '../recreationCopy';
import { MODIFICATION_CHIP_DEFS } from '../modificationIntent';

describe('统一「你想怎么修改这张图片？」意图输入区文案（V4.1 结构化维度选择器）', () => {
  it('标题以用户意图为核心（不再是技术化的「调整要求」）', () => {
    expect(ADJUST_INPUT.title).toBe('你想怎么修改这张图片？');
    expect(ADJUST_INPUT.desc).toContain('大白话');
    expect(ADJUST_INPUT.desc).toContain('再次点击取消');
  });

  it('placeholder 提供大白话示例（引导保持/修改语义）', () => {
    expect(ADJUST_INPUT.placeholder).toContain('保持人物、服装和背景不变');
    expect(ADJUST_INPUT.placeholder).toContain('背景不要动');
  });

  it('快捷 Chip 是结构化维度选择器（toggle，绝不向 textarea 追加文本）', () => {
    expect(MODIFICATION_CHIP_DEFS.length).toBeGreaterThanOrEqual(5);
    for (const chip of MODIFICATION_CHIP_DEFS) {
      expect(chip.label).toBeTruthy();
      expect(chip.label.startsWith('修改')).toBe(true);
    }
    // 维度 key 与文案一一对应（同一维度唯一槽位的数据保证）
    const keys = MODIFICATION_CHIP_DEFS.map(chip => chip.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(MODIFICATION_CHIPS.boostLabel).toBe('提高复刻度');
  });

  it('全模块不再出现旧入口文案', () => {
    const all = [
      ADJUST_INPUT.title, ADJUST_INPUT.desc, ADJUST_INPUT.placeholder,
      OPTIMIZE_TOAST.success, OPTIMIZE_TOAST.idleGuard, OPTIMIZE_TOAST.emptyInstruction,
      GENERATE_DIALOG.title, GENERATE_DIALOG.desc, GENERATE_DIALOG.confirmLabel,
      GENERATION_PARAMS.title, GENERATION_PARAMS.hint,
    ].join('\n');
    expect(all).not.toContain('替换人物');
    expect(all).not.toContain('自由微调');
  });
});

describe('AI 理解 / AI 生成方案 / 评价闭环文案（V4.0.9）', () => {
  it('AI 理解卡：summary 常驻 + 详细分析折叠', () => {
    expect(UNDERSTANDING.title).toBe('AI 已理解这张图片');
    expect(UNDERSTANDING.detailToggle).toContain('详细分析');
  });

  it('AI 生成方案卡：自然语言方案为主，Prompt 编辑统一在 FinalPromptEditor', () => {
    expect(AI_PLAN.title).toBe('AI 生成方案');
    // 旧「编辑生成方案」第二套 Prompt 输入框已删除（单一编辑器见 FINAL_PROMPT）
    expect(AI_PLAN).not.toHaveProperty('editToggle');
    expect(AI_PLAN).not.toHaveProperty('editHint');
  });

  it('评价文案：复刻完成度（不叫图片质量分）+ 继续调整 + 自动评价开关', () => {
    expect(EVALUATION_COPY.overallLabel).toBe('复刻完成度');
    expect(EVALUATION_COPY.continueAdjust).toBe('继续调整');
    expect(EVALUATION_COPY.autoEvaluateLabel).toBe('生成后自动评价');
    expect(EVALUATION_COPY.autoEvaluateHint).toContain('API Key');
  });
});

describe('优化与生成文案', () => {
  it('优化成功 / 空跑保护 / 空要求引导（引导语指向「修改意图」）', () => {
    expect(OPTIMIZE_TOAST.success).toContain('最终生图 Prompt');
    expect(OPTIMIZE_TOAST.idleGuard).toContain('无需重复优化');
    expect(OPTIMIZE_TOAST.emptyInstruction).toContain('修改意图');
  });

  it('确认生成弹层说明包含参数与不重复优化承诺', () => {
    expect(GENERATE_DIALOG.desc).toContain('生成参数');
    expect(GENERATE_DIALOG.desc).toContain('图片工作室');
    expect(GENERATE_DIALOG.confirmLabel).toContain('图片工作室');
  });

  it('生成参数区标签齐全（比例 / 尺寸 / 质量 / 数量）', () => {
    expect(GENERATION_PARAMS.title).toBe('生成参数');
    expect(GENERATION_PARAMS.ratioLabel).toBe('比例');
    expect(GENERATION_PARAMS.sizeLabel).toBe('尺寸');
    expect(GENERATION_PARAMS.qualityLabel).toBe('质量');
    expect(GENERATION_PARAMS.countLabel).toBe('生成数量');
  });

  it('optimizeFailureMessage 归一结尾句号并附重试引导', () => {
    expect(optimizeFailureMessage('模型未返回可用结果')).toBe(
      '模型未返回可用结果。可点击「优化复刻 Prompt」重试，或调整要求后重新优化。',
    );
    expect(optimizeFailureMessage('返回结果格式异常。。。')).not.toContain('。。。');
  });
});

describe('重新优化 / 重新开始 / 无可用视觉模型文案（V4.0.7）', () => {
  it('重新优化提示明确会再次调用 AI 并消耗 Token，失败保留旧结果', () => {
    expect(REOPTIMIZE_ACTION.label).toBe('重新优化');
    expect(REOPTIMIZE_ACTION.hint).toContain('重新调用 AI');
    expect(REOPTIMIZE_ACTION.hint).toContain('Token');
    expect(REOPTIMIZE_ACTION.hint).toContain('保留现有结果');
    expect(REOPTIMIZE_ACTION.emptyInstruction).toContain('修改意图');
  });

  it('重新开始确认文案：明确清空工作区、不影响历史与已生成图片', () => {
    expect(RESTART_ACTION.dialogTitle).toContain('重新开始');
    expect(RESTART_ACTION.dialogDesc).toContain('当前工作区内容将被清空');
    expect(RESTART_ACTION.dialogDesc).toContain('历史任务与已生成图片不受影响');
    expect(RESTART_ACTION.confirmLabel).toContain('清空');
  });

  it('无可用视觉模型提示指向模型管理（唯一事实源）', () => {
    expect(NO_USABLE_VISION_MODEL).toContain('没有可用的视觉模型');
    expect(NO_USABLE_VISION_MODEL).toContain('模型管理');
    expect(NO_USABLE_VISION_MODEL).toContain('图片理解');
  });

  it('重新优化与重新开始是两个语义（文案不混用）', () => {
    expect(REOPTIMIZE_ACTION.hint).not.toContain('清空');
    expect(RESTART_ACTION.dialogDesc).not.toContain('优化');
  });
});

describe('人物替换 / 服装处理 / 分析阶段文案（V4.1）', () => {
  it('人物来源三种固定叫法（图片库人物 / 本地导入 / 文字描述）', () => {
    expect(PERSON_REPLACEMENT.sourceGallery).toBe('图片库人物');
    expect(PERSON_REPLACEMENT.sourceLocal).toBe('本地导入');
    expect(PERSON_REPLACEMENT.sourceDescription).toBe('文字描述');
    expect(PERSON_REPLACEMENT.removeButton).toBe('移除人物替换');
    expect(PERSON_REPLACEMENT.changeButton).toBe('更换人物');
  });

  it('服装处理三种策略 + 自定义输入（严格单选文案）', () => {
    expect(CLOTHING_POLICY.sectionLabel).toBe('服装处理');
    expect(CLOTHING_POLICY.preserveOriginal).toBe('沿用原图服装（推荐）');
    expect(CLOTHING_POLICY.useSubjectReference).toBe('使用参考人物服装');
    expect(CLOTHING_POLICY.custom).toBe('自定义服装');
    expect(CLOTHING_POLICY.customInputLabel).toBe('描述新的服装 / 造型');
  });

  it('分析阶段文案池非空且取值函数越界安全（确定性顺序，非随机）', () => {
    expect(ANALYSIS_PROGRESS.messages.length).toBeGreaterThanOrEqual(8);
    expect(ANALYSIS_PROGRESS.subtitle).toContain('构图');
    expect(getVisualAnalysisMessage(0)).toBe(ANALYSIS_PROGRESS.messages[0]);
    expect(getVisualAnalysisMessage(ANALYSIS_PROGRESS.messages.length)).toBe(ANALYSIS_PROGRESS.messages[0]);
    expect(getVisualAnalysisMessage(-1)).toBe(ANALYSIS_PROGRESS.messages[ANALYSIS_PROGRESS.messages.length - 1]);
    // 文案是产品化中文（不以 Debug 风格冒号开头）
    for (const message of ANALYSIS_PROGRESS.messages) {
      expect(message.endsWith('…')).toBe(true);
      expect(message.startsWith('正在') || message.startsWith('开始') || message.startsWith('马上')).toBe(true);
    }
  });
});
