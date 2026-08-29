import { describe, expect, it } from 'vitest';
import {
  VISION_WIZARD_STEPS,
  getVisualWorkflowState,
  visionStepDone,
  visionStepReachable,
  visionStepStatus,
  type VisionWizardContext,
} from '../visionWizard';

/**
 * V6.7 / V6.8 四步向导纯函数：步骤定义 / 统一 selector / 门禁。
 * V6.8 铁律：完成态只能由 getVisualWorkflowState 派生——素材替换完成 =
 * materialConfirmed（显式确认持久化），绝不从「曾优化过 / 已有素材配置」反推。
 */

const EMPTY: VisionWizardContext = { hasRecreation: false, described: false, materialConfirmed: false, promptReady: false };
const UNDERSTOOD: VisionWizardContext = { ...EMPTY, hasRecreation: true };
const DESCRIBED: VisionWizardContext = { ...UNDERSTOOD, described: true };
const CONFIRMED: VisionWizardContext = { ...DESCRIBED, materialConfirmed: true };
const READY: VisionWizardContext = { ...CONFIRMED, promptReady: true };

describe('VISION_WIZARD_STEPS', () => {
  it('恰好四步且标题 / id / 语义键与用户口径一致', () => {
    expect(VISION_WIZARD_STEPS.map(step => step.title)).toEqual(['视图理解', '需求描述', '素材替换', '最终提示词']);
    expect(VISION_WIZARD_STEPS.map(step => step.id)).toEqual([1, 2, 3, 4]);
    expect(VISION_WIZARD_STEPS.map(step => step.key)).toEqual([
      'visualUnderstanding', 'requirementDescription', 'materialReplacement', 'finalPrompt',
    ]);
  });
});

describe('getVisualWorkflowState（统一 selector）', () => {
  it('逐步推进：空 → 已理解 → 已描述 → 已确认 → Prompt 就绪', () => {
    expect(getVisualWorkflowState(EMPTY).steps.map(step => step.status)).toEqual(['current', 'pending', 'pending', 'pending']);
    expect(getVisualWorkflowState(UNDERSTOOD).steps.map(step => step.status)).toEqual(['completed', 'current', 'pending', 'pending']);
    expect(getVisualWorkflowState(DESCRIBED).steps.map(step => step.status)).toEqual(['completed', 'completed', 'current', 'pending']);
    expect(getVisualWorkflowState(CONFIRMED).steps.map(step => step.status)).toEqual(['completed', 'completed', 'completed', 'current']);
    expect(getVisualWorkflowState(READY).steps.map(step => step.status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('currentStep = 第一个未完成步骤；全部完成时 = 4', () => {
    expect(getVisualWorkflowState(EMPTY).currentStep).toBe(1);
    expect(getVisualWorkflowState(UNDERSTOOD).currentStep).toBe(2);
    expect(getVisualWorkflowState(DESCRIBED).currentStep).toBe(3);
    expect(getVisualWorkflowState(CONFIRMED).currentStep).toBe(4);
    expect(getVisualWorkflowState(READY).currentStep).toBe(4);
  });

  it('第 4 步完成需要 Prompt 就绪（确认后 promptReady=false → current 而非 completed）', () => {
    expect(visionStepStatus(4, CONFIRMED)).toBe('current');
    expect(visionStepStatus(4, READY)).toBe('completed');
  });
});

describe('素材替换完成 = 显式确认（V6.8 老项目兼容铁律）', () => {
  it('A1 旧项目曾优化过（editState=optimized）但从未显式确认 → 素材替换不是已完成', () => {
    // 旧字段 optimized/editState 已从 ctx 移除：即使 promptReady=true（曾优化出最终 Prompt），
    // materialConfirmed=false ⇒ 第 3 步 current、第 4 步 pending
    const legacyOptimized: VisionWizardContext = { ...DESCRIBED, materialConfirmed: false, promptReady: true };
    expect(visionStepDone(3, legacyOptimized)).toBe(false);
    expect(visionStepStatus(3, legacyOptimized)).toBe('current');
    expect(visionStepStatus(4, legacyOptimized)).toBe('pending');
    expect(getVisualWorkflowState(legacyOptimized).currentStep).toBe(3);
  });

  it('A2 旧项目没有任何素材修改（无配置）且未确认 → 「没改素材」≠「已完成」', () => {
    // 无任何素材配置描述字段可反推：described 只代表第 2 步，第 3 步仍 current
    expect(visionStepDone(3, DESCRIBED)).toBe(false);
    expect(visionStepStatus(3, DESCRIBED)).toBe('current');
  });

  it('A3 新版显式确认（materialReplacementDone 持久化为 true）→ 素材替换 completed', () => {
    expect(visionStepDone(3, CONFIRMED)).toBe(true);
    expect(visionStepStatus(3, CONFIRMED)).toBe('completed');
  });

  it('A4 确认后再次修改素材（确认被重置为 false）→ 回到 current，第 4 步重新 pending', () => {
    const afterMaterialChange: VisionWizardContext = { ...CONFIRMED, materialConfirmed: false };
    expect(visionStepStatus(3, afterMaterialChange)).toBe('current');
    expect(visionStepStatus(4, afterMaterialChange)).toBe('pending');
    expect(getVisualWorkflowState(afterMaterialChange).currentStep).toBe(3);
  });
});

describe('visionStepReachable', () => {
  it('未理解时第 2/3/4 步均不可达并给出引导文案', () => {
    for (const step of [2, 3, 4] as const) {
      const gate = visionStepReachable(step, EMPTY);
      expect(gate.ok).toBe(false);
      expect(gate.reason).toContain('视图理解');
    }
    expect(visionStepReachable(1, EMPTY).ok).toBe(true);
  });

  it('第 3 步门禁：必须先在第 2 步描述（用户铁律「进入素材替换一定要先描述」）', () => {
    const gate = visionStepReachable(3, UNDERSTOOD);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('需求描述');
    expect(visionStepReachable(2, UNDERSTOOD).ok).toBe(true);
    expect(visionStepReachable(3, DESCRIBED).ok).toBe(true);
  });

  it('已描述后第 4 步始终可达（查看最终 Prompt 不受优化 / 确认状态限制）', () => {
    expect(visionStepReachable(4, DESCRIBED).ok).toBe(true);
    expect(visionStepReachable(4, CONFIRMED).ok).toBe(true);
  });
});
