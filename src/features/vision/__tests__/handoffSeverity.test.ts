/**
 * V6.3 Notification Severity Contract（§3-§7/§49）回归：
 *
 * 语义铁律：修正类 Toast 的严重级由「最终用户状态」决定，不是「内部是否执行过 Guard」：
 *  - 系统已按合同完成修正（动漫一致性 / 服装来源 / 维度锁定）⇒ success（绿）；
 *  - 唯一 warning 例外：被剥离内容来自用户当前文字要求（结果与用户要求不同）；
 *  - error（红）只属于阻断场景，不走本模块。
 * UI 接线：VisionUnderstanding 三个 guard toast 必须按严重级调 toastSuccess / toastWarning。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  contractCorrectionSeverity,
  lockCorrectionSeverity,
  resetCorrectionToastDedup,
  shouldShowCorrectionToast,
} from '../handoffOperation';

const PAGE_SRC = readFileSync(new URL('../../../pages/VisionUnderstanding.tsx', import.meta.url), 'utf-8');

describe('V6.3 §57 修正 Toast 严重级（判断依据 = 最终用户状态）', () => {
  it('guardSeveritySuccessByDefault：合同型守卫（动漫 / 服装）已完成修正 ⇒ 恒 success', () => {
    expect(contractCorrectionSeverity()).toBe('success');
  });

  it('lockDriftFromUserInstructionIsWarning：漂移句来自用户当前指令 ⇒ warning（结果与用户要求不同）', () => {
    const instruction = '把人物换成红发女孩，动作改为站立并且双手插兜';
    const removed = ['动作改为站立并且双手插兜'];
    expect(lockCorrectionSeverity(removed, instruction)).toBe('warning');
  });

  it('lockDriftFromOptimizerIsSuccess：漂移句不来自用户指令（旧优化残留）⇒ success（合同被正确执行）', () => {
    const instruction = '把人物换成红发女孩';
    const removed = ['人物以跪姿出现在画面左侧并保持黑色长直发'];
    expect(lockCorrectionSeverity(removed, instruction)).toBe('success');
    // 空指令（用户没写字）= 一切剥离都不是用户显式要求
    expect(lockCorrectionSeverity(removed, '')).toBe('success');
    expect(lockCorrectionSeverity(removed, '   ')).toBe('success');
  });

  it('shortFragmentsNeverAttributed：过短片段（<4 字符）不做子串归因 ⇒ success（避免噪声误报）', () => {
    expect(lockCorrectionSeverity(['红', '改'], '把红改成蓝，改动作')).toBe('success');
    expect(lockCorrectionSeverity([], '任意指令')).toBe('success');
  });

  it('pageWiresSeverityHelpers：视觉页 guard toast 按严重级分流（success 绿 / warning 橙），非一律 warning', () => {
    expect(PAGE_SRC).toContain('contractCorrectionSeverity()');
    expect(PAGE_SRC).toContain('lockCorrectionSeverity(');
    // 三个已保持标题的 toast 都有 success 分支（系统完成修正 = 绿色确认）
    for (const title of ['已保持动漫角色一致', '已保持人物参考服装', '已保持锁定内容']) {
      expect(PAGE_SRC).toContain(`'${title}'`);
    }
    expect(PAGE_SRC).toContain('toastSuccess');
  });

  it('dedupStillApplies：同 operation 同 key 只提示一次（严重级改造不破坏 V6.2 去重）', () => {
    resetCorrectionToastDedup();
    expect(shouldShowCorrectionToast('op-sev-1', 'lock_guard')).toBe(true);
    expect(shouldShowCorrectionToast('op-sev-1', 'lock_guard')).toBe(false);
    expect(shouldShowCorrectionToast('op-sev-2', 'lock_guard')).toBe(true);
  });
});
