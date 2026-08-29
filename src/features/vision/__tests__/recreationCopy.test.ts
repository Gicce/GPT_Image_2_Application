import { describe, it, expect } from 'vitest';
import {
  ADJUST_INPUT,
  AI_PLAN,
  ANALYSIS_PROGRESS,
  CLOTHING_POLICY,
  EVALUATION_COPY,
  GENERATE_DIALOG,
  GENERATION_PARAMS,
  IMAGE_MENTION,
  MENTION_SUGGESTION,
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
    expect(ADJUST_INPUT.desc).toContain('点击快捷按钮');
    expect(ADJUST_INPUT.desc).toContain('@');
  });

  it('placeholder 传达 @ 图片引用能力（V4.0.9）', () => {
    expect(ADJUST_INPUT.placeholder).toContain('输入 @ 引用当前任务图片');
    expect(ADJUST_INPUT.desc).toContain('把 @图二 的人物换成 @图三');
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

describe('人物替换 / 服装来源 / 分析阶段文案（V6.3 紧凑分组口径）', () => {
  it('身份来源三种固定叫法（图片库 / 本地导入 / 文字描述，Segmented Control 短标签）', () => {
    expect(PERSON_REPLACEMENT.sourceGallery).toBe('图片库');
    expect(PERSON_REPLACEMENT.sourceLocal).toBe('本地导入');
    expect(PERSON_REPLACEMENT.sourceDescription).toBe('文字描述');
    expect(PERSON_REPLACEMENT.sourceLabel).toBe('身份来源');
    expect(PERSON_REPLACEMENT.removeButton).toBe('移除人物替换');
    expect(PERSON_REPLACEMENT.changeButton).toBe('更换人物参考');
  });

  it('V6.3 四分组标签（主体 / 来源 / 执行范围 / 替换强度）', () => {
    expect(PERSON_REPLACEMENT.groupSubject).toBe('主体');
    expect(PERSON_REPLACEMENT.groupSource).toBe('来源');
    expect(PERSON_REPLACEMENT.groupScope).toBe('执行范围');
    expect(PERSON_REPLACEMENT.groupStrength).toBe('替换强度');
  });

  it('业务卡文案：人物替换是高优先级业务动作，区分画面模板与替换人物', () => {
    expect(PERSON_REPLACEMENT.businessBadge).toBe('已启用');
    expect(PERSON_REPLACEMENT.businessDesc).toContain('沿用原图');
    expect(PERSON_REPLACEMENT.templateLabel).toBe('画面模板');
    expect(PERSON_REPLACEMENT.templateUseHint).toContain('构图');
    expect(PERSON_REPLACEMENT.personBlockLabel).toBe('替换人物');
    expect(PERSON_REPLACEMENT.personUseHint).toContain('身份');
    expect(PERSON_REPLACEMENT.templateChangeButton).toBe('更换模板');
    expect(PERSON_REPLACEMENT.templateToken).toBe('原图');
    expect(PERSON_REPLACEMENT.personCardTitle).toBe('人物参考');
  });

  it('服装来源三种策略 + 自定义输入（Segmented Control 短标签；默认值语义不变）', () => {
    expect(CLOTHING_POLICY.sectionLabel).toBe('服装来源');
    expect(CLOTHING_POLICY.preserveOriginal).toBe('原图服装');
    expect(CLOTHING_POLICY.useSubjectReference).toBe('人物服装');
    expect(CLOTHING_POLICY.custom).toBe('自定义');
    expect(CLOTHING_POLICY.customInputLabel).toBe('服装描述');
  });

  it('V6.8 减法版：每个来源一句上下文提示（单句、不解释实现规则）', () => {
    expect(CLOTHING_POLICY.preserveOriginalHint).toBe('保持原图服装不变。');
    expect(CLOTHING_POLICY.useSubjectReferenceHint).toBe('将使用人物参考图中的服装。');
    expect(CLOTHING_POLICY.customHint).toBe('描述希望替换的服装与造型。');
    expect(CLOTHING_POLICY.customInputPlaceholder).toContain('描述');
    // 单句铁律：以句号结尾且句中无第二个句号 / 分号
    for (const hint of [
      CLOTHING_POLICY.preserveOriginalHint,
      CLOTHING_POLICY.useSubjectReferenceHint,
      CLOTHING_POLICY.customHint,
    ]) {
      expect(hint.endsWith('。')).toBe(true);
      expect(hint.split('。').filter(Boolean)).toHaveLength(1);
      expect(hint).not.toContain('；');
      expect(hint).not.toContain('维度');   // 实现规则（clothing 维度自动启停）不向用户解释
      expect(hint).not.toContain('自动');
    }
  });

  it('V6.8 服装参考 / 多人服装文案（参考仅自定义时可选；多人单行入口）', () => {
    expect(CLOTHING_POLICY.referenceLabel).toBe('服装参考');
    expect(CLOTHING_POLICY.referenceHintCustom).toContain('服装');
    expect(CLOTHING_POLICY.multiLabel).toBe('多人服装');
    expect(CLOTHING_POLICY.multiButton).toBe('分别设置');
    expect(CLOTHING_POLICY.refCardNote).toContain('参考');
  });

  it('@图片引用与建议条文案（V4.0.9）', () => {
    expect(IMAGE_MENTION.popupTitle).toBe('引用图片');
    expect(IMAGE_MENTION.popupSectionTask).toBe('当前任务');
    expect(IMAGE_MENTION.popupPickGallery).toContain('图片库');
    expect(MENTION_SUGGESTION.apply).toBe('应用到人物替换');
    expect(MENTION_SUGGESTION.templateLabel).toBe('模板图');
    expect(MENTION_SUGGESTION.personLabel).toBe('替换人物');
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
