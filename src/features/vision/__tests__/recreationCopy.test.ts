import { describe, it, expect } from 'vitest';
import {
  ADJUST_INPUT,
  GENERATE_DIALOG,
  GENERATION_PARAMS,
  NO_USABLE_VISION_MODEL,
  OPTIMIZE_TOAST,
  REOPTIMIZE_ACTION,
  RESTART_ACTION,
  optimizeFailureMessage,
} from '../recreationCopy';

describe('统一「调整要求」输入框文案', () => {
  it('标题与说明符合统一输入框交互（不再有分叉入口）', () => {
    expect(ADJUST_INPUT.title).toBe('调整要求');
    expect(ADJUST_INPUT.desc).toContain('直接输入你希望调整的内容');
    expect(ADJUST_INPUT.desc).toContain('复刻方案、锁定项和你的要求');
    expect(ADJUST_INPUT.desc).toContain('重新优化');
  });

  it('placeholder 提供大白话示例（引导锁定/可修改语义）', () => {
    expect(ADJUST_INPUT.placeholder).toContain('保持背景和构图不变');
    expect(ADJUST_INPUT.placeholder).toContain('背景不要动');
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

describe('优化与生成文案', () => {
  it('优化成功 / 空跑保护 / 空要求引导', () => {
    expect(OPTIMIZE_TOAST.success).toContain('最终生图 Prompt');
    expect(OPTIMIZE_TOAST.idleGuard).toContain('无需重复优化');
    expect(OPTIMIZE_TOAST.emptyInstruction).toContain('调整要求');
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
    expect(REOPTIMIZE_ACTION.emptyInstruction).toContain('调整要求');
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
