import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const pageDir = resolve(__dirname, '..');
const pageSrc = readFileSync(resolve(pageDir, 'VisionUnderstanding.tsx'), 'utf8');
const cssSrc = readFileSync(resolve(pageDir, 'VisionUnderstanding.css'), 'utf8');
const viewStoreSrc = readFileSync(resolve(pageDir, '../store/useVisionViewStore.ts'), 'utf8');
const railSrc = readFileSync(resolve(pageDir, '../features/vision/project/ContextRail.tsx'), 'utf8');

/**
 * V6.7 四步向导源码契约：左侧步骤栏（视图理解/需求描述/素材替换/最终提示词）+
 * 当前步骤内容 + ContextRail 项目进度卡；门禁与自动前进；阶段条（V6.6）已被取代。
 * 纯视图层：wizardStep 只存 view store，语义链路（modificationDraft / semanticRevision /
 * commitModificationDraft / 优化器）零触碰。
 */

describe('步骤栏与向导容器', () => {
  test('四步步骤栏存在，标题与门禁/完成态派生自 visionWizard 纯函数', () => {
    expect(pageSrc).toContain('className="vision-wizard"');
    expect(pageSrc).toContain('VISION_WIZARD_STEPS.map');
    expect(pageSrc).toContain('visionStepReachable(stepDef.id, wizardCtx).ok');
    // V6.8：完成态只从统一 selector 的 workflowState 查表，禁止分散字段猜测
    expect(pageSrc).toContain('const workflowState = getVisualWorkflowState(wizardCtx);');
    expect(pageSrc).toContain('workflowState.steps.find(step => step.id === stepDef.id)?.status ?? \'pending\'');
    expect(pageSrc).toContain('goWizardStep(stepDef.id)');
  });

  test('V6.8 wizardCtx 只含四个事实字段（materialConfirmed 显式确认，不收旧 optimized/editState）', () => {
    const ctxAt = pageSrc.indexOf('const wizardCtx: VisionWizardContext = {');
    expect(ctxAt).toBeGreaterThan(-1);
    const ctxBlock = pageSrc.slice(ctxAt, pageSrc.indexOf('};', ctxAt));
    expect(ctxBlock).toContain('hasRecreation');
    expect(ctxBlock).toContain('described');
    expect(ctxBlock).toContain('materialConfirmed');
    expect(ctxBlock).toContain('promptReady');
    // 旧完成态字段绝不进入 ctx（注释提及旧字段名属于规则说明，不算使用）
    expect(ctxBlock).not.toContain('optimized');
    expect(ctxBlock).not.toContain('editState ===');
    expect(ctxBlock).not.toContain('optimizedRevision');
    // promptReady = 有方案且无需再优化（不读 editState）
    expect(ctxBlock).toContain('needsOptimization(recreation)');
  });

  test('V6.6 阶段条已被取代（源码与样式均无残留）', () => {
    expect(pageSrc).not.toContain('vision-stage-bar');
    expect(pageSrc).not.toContain('MODIFICATION_STAGES');
    expect(cssSrc).not.toContain('.vision-stage-bar');
    expect(cssSrc).toContain('.vision-wizard');
    expect(cssSrc).toContain('.vision-step-btn.is-active');
  });

  test('wizardStep 只存在于 view store（视图/语义分离铁律）', () => {
    expect(viewStoreSrc).toContain('wizardStep: 1 as const');
    expect(viewStoreSrc).toContain('setVisionStep: step => set({ wizardStep: step })');
    expect(viewStoreSrc).not.toContain('activeStage');
  });
});

describe('四步内容归位', () => {
  test('第 1 步：预览面板 / 分析进度 / AI 已理解卡', () => {
    expect(pageSrc).toContain('{wizardStep === 1 && (');
    expect(pageSrc).toContain('<ProjectPreviewPanel');
    expect(pageSrc).toContain("wizardStep === 1 && stage === 'analyzing'");
    expect(pageSrc).toContain('wizardStep === 1 && analysis && (');
  });

  test('第 2 步：需求描述（自定义修改内容 + 胶囊 + 优化引导），不再夹带替换面板', () => {
    const step2At = pageSrc.indexOf('reverseResult && wizardStep === 2 &&');
    const step3At = pageSrc.indexOf('reverseResult && wizardStep === 3 &&');
    expect(step2At).toBeGreaterThan(-1);
    expect(step3At).toBeGreaterThan(step2At);
    const step2Block = pageSrc.slice(step2At, step3At);
    expect(step2Block).toContain('自定义修改内容');
    expect(step2Block).toContain('<IntentMentionInput');
    expect(step2Block).toContain('<ModificationChips');
    expect(step2Block).toContain('自动进入第 3 步「素材替换」');
    expect(step2Block).not.toContain('<PersonReplacementPanel');
  });

  test('第 3 步：素材替换面板全量归位（人物/服装/维度 + 区域编辑 + 空态引导 + 显式确认 footer）', () => {
    const step3At = pageSrc.indexOf('reverseResult && wizardStep === 3 &&');
    const step4At = pageSrc.indexOf('recreation && wizardStep === 4 &&');
    expect(step3At).toBeGreaterThan(-1);
    expect(step4At).toBeGreaterThan(step3At);
    const step3Block = pageSrc.slice(step3At, step4At);
    expect(step3Block).toContain('<PersonReplacementPanel');
    expect(step3Block).toContain('<ClothingChangePanel');
    expect(step3Block).toContain("(['pose', 'scene', 'camera', 'style'] as const).map");
    expect(step3Block).toContain('<RegionEditorPanel');
    expect(step3Block).toContain('vision-step-empty');
    // V6.8 §七：完成唯一入口 = 用户点击确认按钮（「没改素材」≠「已完成」）
    expect(step3Block).toContain('vision-step-confirm');
    expect(step3Block).toContain('data-testid="material-confirm-button"');
    expect(step3Block).toContain('confirmMaterialReplacement');
    // 维度面板保留语义回调锚点（块内直接调用；writeDimensionRequirement / setGalleryPurpose 在处理函数体内）
    expect(step3Block).toContain('updateDimensionRequirement(dimension, value)');
    expect(step3Block).toContain('setDimensionReference(dimension, null)');
    expect(step3Block).toContain('pickDimensionReferenceFromGallery(dimension)');
    expect(pageSrc).toContain('writeDimensionRequirement');
    expect(pageSrc).toContain("setGalleryPurpose('dimension-reference')");
  });

  test('第 4 步：最终提示词卡（AI 生成方案 + FinalPromptEditor）', () => {
    const step4At = pageSrc.indexOf('recreation && wizardStep === 4 &&');
    expect(step4At).toBeGreaterThan(-1);
    expect(pageSrc.slice(step4At)).toContain('vision-final-prompt');
  });

  test('状态栏与 Prompt 操作行是第 2-4 步共用脚注（含无项目 CTA 兜底）', () => {
    const footerAt = pageSrc.indexOf('reverseResult && wizardStep >= 2 &&');
    expect(footerAt).toBeGreaterThan(-1);
    const footerBlock = pageSrc.slice(footerAt, pageSrc.indexOf('</div>{/* .vision-step-content 结束 */}'));
    expect(footerBlock).toContain('vision-status-bar');
    expect(footerBlock).toContain('确认生成图片');
    expect(footerBlock).toContain('优化复刻 Prompt');
  });
});

describe('门禁与自动前进', () => {
  test('点击步骤走 goWizardStep 门禁（不可达 toast 说明原因，不静默）', () => {
    expect(pageSrc).toContain('const goWizardStep = (step: VisionWizardStep) => {');
    expect(pageSrc).toContain('toastInfo(gate.reason');
  });

  test('理解结果首次就绪 → 自动进第 2 步（分析成功与项目载入共用）', () => {
    expect(pageSrc).toContain('hadRecreationRef.current && useVisionViewStore.getState().wizardStep === 1');
    expect(pageSrc).toContain('useVisionViewStore.getState().setVisionStep(2)');
  });

  test('Prompt 优化成功 → 第 2 步进 3、第 3 步进 4（第 4 步保持）', () => {
    expect(pageSrc).toContain('currentWizardStep >= 2 && currentWizardStep < 4');
    expect(pageSrc).toContain('setVisionStep((currentWizardStep + 1) as VisionWizardStep)');
  });
});

describe('ContextRail 项目进度卡（右侧：进度 + 替换情况 + skill 应用）', () => {
  test('页面派生 wizardProgress，Rail 顶部渲染进度 checklist', () => {
    expect(pageSrc).toContain('wizardProgress={VISION_WIZARD_STEPS.map(stepDef => ({');
    expect(railSrc).toContain('vision-rail-progress');
    expect(railSrc).toContain("aria-label=\"当前方案\"");
    // 替换情况（合同行）与技能执行区仍在 Rail
    expect(railSrc).toContain('plan.rows.map');
    expect(railSrc).toContain('vision-rail-skills');
    expect(cssSrc).toContain('.vision-rail-progress-list');
  });
});

describe('已启用卡边框一致性（V6.6 保留项）', () => {
  test('人物 / 服装 / 维度三面板统一 accent 边框', () => {
    for (const panelClass of ['.vision-person-panel.is-business', '.vision-clothing-panel', '.vision-dimension-edit-panel']) {
      const start = cssSrc.indexOf(panelClass);
      expect(start).toBeGreaterThan(-1);
      const rule = cssSrc.slice(start, cssSrc.indexOf('}', start));
      expect(rule).toContain('var(--accent-primary)');
    }
  });
});

describe('V6.8 素材替换显式确认（确认 / 复位链路）', () => {
  test('确认 = updateActiveMeta + 快照字段 + 进第 4 步（不加修订，不触发待优化）', () => {
    expect(pageSrc).toContain('const confirmMaterialReplacement = () => {');
    expect(pageSrc).toContain('pstate.updateActiveMeta(draft => ({');
    expect(pageSrc).toContain('workspace: { ...draft.workspace, materialReplacementDone: true }');
    expect(pageSrc).toContain('setMaterialReplacementDone(true)');
    expect(pageSrc).toContain("setVisionStep(4)");
  });

  test('素材域修改复位确认位（无项目链路在 commitModificationDraft 内复位；项目链路由 store 钩子复位）', () => {
    expect(pageSrc).toContain('setMaterialReplacementDone(false)');
    expect(pageSrc).toContain('unconfirmMaterialReplacement');
  });
});

describe('V6.8 优化真实进度（Progress Honesty §36）', () => {
  test('进度只存事实（status / startedAt / errorText），阶段来自服务 onStage 回调', () => {
    expect(pageSrc).toContain("const [optimizeProgress, setOptimizeProgress] = useState<{ status: PromptOptimizationStatus; startedAt: number; errorText?: string }>");
    expect(pageSrc).toContain("setOptimizeProgress({ status: 'collecting', startedAt: Date.now() })");
    expect(pageSrc).toContain('onStage: stage => setOptimizeProgress(prev => (');
    expect(pageSrc).toContain("status: 'completed', startedAt: prev.startedAt");
    expect(pageSrc).toContain("status: 'failed', startedAt: prev.startedAt, errorText: optimizeFailureMessage(outcome.error)");
  });

  test('绝无假进度：页面不写百分比，不随时间随机推进（percent 只由 deriveOptimizationPercent 派生）', () => {
    expect(pageSrc).not.toContain('percent +=');
    expect(pageSrc).not.toContain('Math.random()');
    expect(pageSrc).not.toContain('setInterval'); // 已用时计时在 OptimizeProgressCard 内部，页面无自增循环
  });

  test('无项目 footer：运行中 / 完成态隐藏操作按钮，进度卡替换按钮区', () => {
    expect(pageSrc).toContain('<OptimizeProgressCard');
    expect(pageSrc).toContain('(isOptimizationRunning(optimizeProgress.status) || optimizeProgress.status === \'completed\') ? null : (');
    expect(pageSrc).toContain('onRetryOptimize');
  });

  test('Rail CTA：运行期进度卡替换全部按钮；区域替换行可定位', () => {
    expect(railSrc).toContain('isOptimizationRunning(optimizeProgress.status) ? (');
    expect(railSrc).toContain('<OptimizeProgressCard');
    expect(railSrc).toContain('vision-rail-locate');
    expect(railSrc).toContain('onLocateRow?.(row.key)');
    expect(cssSrc).toContain('.vision-optimize-progress-fill.is-animated');
    expect(cssSrc).toContain('.vision-rail-locate');
  });
});
