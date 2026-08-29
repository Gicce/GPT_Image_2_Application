/**
 * V6.8.1 统一「有效复刻意图 → 优化输入」payload 内容级测试（Case A–F）。
 *
 * 断言 optimizer 实际收到的指令内容（用户填写的全部当前生效要求真实进入），
 * 不是只测「按钮可见 / 事件触发」；同时守住源码接线（页面所有语义写入口
 * 都走 buildRecreationOptimizationInstruction / syncRecreationInstructionFromProject）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPersonContractLines,
  buildRecreationOptimizationInstruction,
  collectEffectiveRegionReplacements,
  getEffectiveModificationDraft,
} from '../recreationOptimizationInput';
import {
  EMPTY_MODIFICATION_DRAFT,
  writeDimensionRequirement,
  type ModificationDraft,
} from '../modificationIntent';
import {
  applyModificationInstruction,
  applyOptimizationResult,
  buildRecreationPlan,
  initialRecreationState,
  markOptimizing,
  needsOptimization,
} from '../recreationPlan';
import { fixtureAnalysis, fixtureProject } from '../project/__tests__/fixtures';
import type { PersonReplacementContract, VisualProject } from '../project/types';

/** 第 2 步需求描述草稿（freeText 含维度要求行 = 用户原话，不建立隐藏语义）。 */
function draftWith(overrides: Partial<ModificationDraft>): ModificationDraft {
  return { ...EMPTY_MODIFICATION_DRAFT, ...overrides };
}

/** 人物替换合同 V2（项目侧事实源）。 */
function personContract(overrides?: Partial<PersonReplacementContract>): PersonReplacementContract {
  return {
    enabled: true,
    source: 'gallery',
    path: 'D:/imgs/person-a.png',
    label: '主人物参考',
    strength: 'strict',
    replaceScope: 'whole_person',
    preserveTemplateIdentity: false,
    applyIdentityTo: 'primary_subject_only',
    ...overrides,
  };
}

/** 带区域替换的项目：2 个启用（物体 / 背景）+ 1 个停用（绝不能进优化输入）。 */
function projectWithRegions(person?: PersonReplacementContract | null): VisualProject {
  const project = fixtureProject();
  return {
    ...project,
    modification: { ...project.modification, person: person ?? project.modification.person },
    references: [
      ...project.references,
      { id: 'ref-multi-1', assetId: 'asset-multi-1', path: 'D:/imgs/person-b.png', label: '闺蜜人物参考', kind: 'person' as const, source: 'gallery' as const },
    ],
    regions: [
      {
        id: 'region-1',
        name: '手中的手机',
        shape: { kind: 'rect', x: 0.55, y: 0.4, w: 0.18, h: 0.14 },
        replaceType: 'object',
        constraintStrength: 'balanced',
        prompt: '透明玻璃杯',
        enabled: true,
        createdAt: '2026-08-28T00:00:00.000Z',
      },
      {
        id: 'region-2',
        name: '背景墙',
        shape: { kind: 'rect', x: 0, y: 0, w: 1, h: 0.3 },
        replaceType: 'person',
        constraintStrength: 'strict',
        replaceScope: 'whole_person',
        personReferenceId: 'ref-multi-1',
        prompt: '站姿闺蜜，看向镜头',
        enabled: true,
        createdAt: '2026-08-28T00:00:00.000Z',
      },
      {
        id: 'region-off',
        name: '已停用区域',
        shape: { kind: 'rect', x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        replaceType: 'object',
        constraintStrength: 'balanced',
        prompt: '不该进入优化输入的内容',
        enabled: false,
        createdAt: '2026-08-28T00:00:00.000Z',
      },
    ],
  };
}

describe('V6.8.1 统一优化输入：用户填写的全部当前生效要求进入 optimizer payload', () => {
  it('Case A 风格要求：自由文本原话完整进入指令（不只传 style = enabled）', () => {
    const draft = draftWith({
      freeText: writeDimensionRequirement('', 'style', '赛璐璐动漫风，冷紫色调，霓虹背景'),
      activeDimensions: ['style'],
    });
    const instruction = buildRecreationOptimizationInstruction(draft, null);
    expect(instruction).toContain('风格要求：赛璐璐动漫风，冷紫色调，霓虹背景');
    expect(instruction).toContain('风格修改（已启用）');
  });

  it('Case B 自定义服装：clothingPolicy=custom 时 customClothing 完整进入指令', () => {
    const draft = draftWith({
      clothingPolicy: 'custom',
      customClothing: '白色露肩连衣裙，银色项链，黑色丝袜',
      activeDimensions: ['clothing'],
    });
    const instruction = buildRecreationOptimizationInstruction(draft, null);
    expect(instruction).toContain('服装处理：更换为指定服装——白色露肩连衣裙，银色项链，黑色丝袜');
  });

  it('Case C 人物服装：切到 use_subject_reference 后，历史自定义服装文本绝不进入指令', () => {
    // 存储态残留：用户先填「红色制服」再切成「人物服装」（setClothingPolicy 不清 customClothing）
    const stored = draftWith({
      person: { source: 'gallery', path: 'D:/imgs/person-a.png', label: '主人物参考' },
      clothingPolicy: 'use_subject_reference',
      customClothing: '红色制服',
      activeDimensions: ['subject', 'clothing'],
    });
    // 有效意图清洗：非 custom 策略下 customClothing 必须为空
    expect(getEffectiveModificationDraft(stored).customClothing).toBe('');
    const instruction = buildRecreationOptimizationInstruction(stored, null);
    expect(instruction).toContain('使用人物参考图中的服装');
    expect(instruction).not.toContain('红色制服');
  });

  it('Case C′ 服装来源三态的另外两侧：preserve_original 显式保持原图服装', () => {
    const stored = draftWith({
      person: { source: 'gallery', path: 'D:/imgs/person-a.png', label: '主人物参考' },
      clothingPolicy: 'preserve_original',
      customClothing: '红色制服',
      activeDimensions: ['subject'],
    });
    const instruction = buildRecreationOptimizationInstruction(stored, null);
    expect(instruction).toContain('严格保留原图（画面模板）服装');
    expect(instruction).not.toContain('红色制服');
  });

  it('Case D 区域替换：逐区域「是什么 / 替换为什么 / 参考素材」进入指令，绝非只有计数', () => {
    const instruction = buildRecreationOptimizationInstruction(EMPTY_MODIFICATION_DRAFT, projectWithRegions());
    expect(instruction).toContain('区域替换（逐区域执行，共 2 个');
    expect(instruction).toContain('「手中的手机」');
    expect(instruction).toContain('：替换为——透明玻璃杯');
    expect(instruction).toContain('「背景墙」');
    expect(instruction).toContain('站姿闺蜜，看向镜头');
    expect(instruction).toContain('人物身份以参考图「闺蜜人物参考」为准');
    expect(instruction).toContain('身份强度=严格');
    // 停用区域是存储态、不是生效态：绝不进入优化输入
    expect(instruction).not.toContain('不该进入优化输入的内容');
    expect(collectEffectiveRegionReplacements(projectWithRegions())).toHaveLength(2);
  });

  it('Case D′ 人物替换合同 V2（强度 / 范围 / 身份应用）进入指令', () => {
    const lines = buildPersonContractLines(projectWithRegions(personContract({ strength: 'strict', replaceScope: 'face' })));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('强度=严格');
    expect(lines[0]).toContain('替换范围=脸部');
    expect(lines[0]).toContain('身份应用=仅主主体');
    // 无人物合同 / 未启用 = 空行（不虚构）
    expect(buildPersonContractLines(projectWithRegions(null))).toHaveLength(0);
    expect(buildPersonContractLines(null)).toHaveLength(0);
  });

  it('Case E 多项并存：人物替换 + 风格要求 + 自定义服装 + 区域替换 + 背景要求一个不漏', () => {
    const draft = draftWith({
      person: { source: 'gallery', path: 'D:/imgs/person-a.png', label: '主人物参考' },
      freeText: writeDimensionRequirement(
        writeDimensionRequirement('', 'style', '日系赛璐璐插画，冷紫色调'),
        'scene',
        '傍晚街景，橱窗灯光',
      ),
      activeDimensions: ['subject', 'style', 'scene', 'clothing'],
      clothingPolicy: 'custom',
      customClothing: '白色露肩连衣裙',
    });
    const project = projectWithRegions(personContract());
    const instruction = buildRecreationOptimizationInstruction(draft, project);
    // 人物替换（草稿侧）
    expect(instruction).toContain('人物替换（强制条件）');
    // 风格要求 + 背景要求（自由文本原话）
    expect(instruction).toContain('风格要求：日系赛璐璐插画，冷紫色调');
    expect(instruction).toContain('背景要求：傍晚街景，橱窗灯光');
    // 自定义服装
    expect(instruction).toContain('更换为指定服装——白色露肩连衣裙');
    // 区域替换（含参考素材）
    expect(instruction).toContain('「手中的手机」');
    expect(instruction).toContain('：替换为——透明玻璃杯');
    // 人物替换合同 V2
    expect(instruction).toContain('人物替换合同：强度=严格');
  });

  it('Case F 修改后过期：优化完成后改风格文本 / 改区域都必须 needsOptimization=true', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    let state = initialRecreationState(plan, '原始复刻 Prompt', '');
    expect(needsOptimization(state)).toBe(false);

    // 第一轮：风格要求 → 优化完成（revision 对齐）
    const styleDraft = draftWith({
      freeText: writeDimensionRequirement('', 'style', '赛璐璐动漫风'),
      activeDimensions: ['style'],
    });
    state = applyModificationInstruction(state, buildRecreationOptimizationInstruction(styleDraft, null));
    expect(needsOptimization(state)).toBe(true);
    state = applyOptimizationResult(markOptimizing(state), {
      optimizedPrompt: '最终 Prompt v1',
      optimizedNegativePrompt: '',
      summary: '已按风格要求重建',
    });
    expect(needsOptimization(state)).toBe(false);

    // 优化完成后修改风格文本 → 过期（「复刻成我的技能」可用性同源派生自 needsOptimization）
    const styleDraftV2 = draftWith({
      freeText: writeDimensionRequirement('', 'style', '赛璐璐动漫风，冷紫色调'),
      activeDimensions: ['style'],
    });
    state = applyModificationInstruction(state, buildRecreationOptimizationInstruction(styleDraftV2, null));
    expect(needsOptimization(state)).toBe(true);

    // 再优化完成后仅动区域（第 3 步素材替换）→ 同样过期（V6.8.1 核心修复）
    state = applyOptimizationResult(markOptimizing(state), {
      optimizedPrompt: '最终 Prompt v2',
      optimizedNegativePrompt: '',
      summary: '已重建',
    });
    expect(needsOptimization(state)).toBe(false);
    state = applyModificationInstruction(
      state,
      buildRecreationOptimizationInstruction(styleDraftV2, projectWithRegions()),
    );
    expect(needsOptimization(state)).toBe(true);
    expect(state.adjustInstruction).toContain('：替换为——透明玻璃杯');
  });
});

/** 源码接线契约：页面语义写入口全部走统一构建器；CTA 恢复「复刻成我的技能」。 */
describe('V6.8.1 源码接线契约（页面 / Rail / CSS）', () => {
  const pageSrc = readFileSync(resolve(__dirname, '../../../pages/VisionUnderstanding.tsx'), 'utf8');
  const railSrc = readFileSync(resolve(__dirname, '../project/ContextRail.tsx'), 'utf8');
  const cssSrc = readFileSync(resolve(__dirname, '../../../pages/VisionUnderstanding.css'), 'utf8');

  it('commitModificationDraft / optimizeRecreationPrompt 都经统一构建器组装指令', () => {
    expect(pageSrc).toMatch(/const instruction = buildRecreationOptimizationInstruction\(nextDraft, pstate\.active,/);
    expect(pageSrc).toMatch(/const instruction = buildRecreationOptimizationInstruction\(\s*\/\/ 复刻度增强技能停用/);
  });

  it('区域变更 / 人物合同 V2 / 区域人物参考绑定三条入口都触发指令重建（过期）', () => {
    const syncCount = (pageSrc.match(/syncRecreationInstructionFromProject\(\);/g) ?? []).length;
    expect(syncCount).toBe(3); // 调用 3：regions / person 合同 V2 / region-person 图库绑定
    expect(pageSrc).toMatch(/updateActive\('regions'[\s\S]{0,200}syncRecreationInstructionFromProject\(\);/);
    expect(pageSrc).toMatch(/updateActive\('person'[\s\S]{0,200}syncRecreationInstructionFromProject\(\);/);
  });

  it('「复刻成我的技能」恢复在 CTA 区且复用原 SkillCreatorDialog 链路（不另写保存逻辑）', () => {
    // 页面：共享 handler + 可用判定（沿用旧业务条件：有项目 + 最终 Prompt 有效）
    expect(pageSrc).toContain('const saveRecreationAsSkill = () => {');
    expect(pageSrc).toContain('onSaveAsSkill={saveRecreationAsSkill}');
    expect(pageSrc).toContain('canSaveAsSkill={canSaveAsSkill}');
    expect(pageSrc).toMatch(/canSaveAsSkill = Boolean\(\s*activeProject\s*&& recreation\s*&& !needsOptimization\(recreation\)/);
    // Rail：Secondary Action（无高强调 class），位于「优化复刻 Prompt」与「确认生成图片」之间
    const cautionIdx = railSrc.indexOf('>优化复刻 Prompt</button>');
    const saveIdx = railSrc.indexOf('>{SAVE_AS_SKILL_ACTION.label}</button>');
    const primaryIdx = railSrc.indexOf('>确认生成图片</button>');
    expect(saveIdx).toBeGreaterThan(cautionIdx);
    expect(primaryIdx).toBeGreaterThan(saveIdx);
    expect(railSrc).toContain('SAVE_AS_SKILL_ACTION.label');
    // 弹窗链路原样保留（SkillCreatorDialog → 我的技能）
    expect(pageSrc).toContain('<SkillCreatorDialog');
    expect(pageSrc).toContain('onSaved={() => toastSuccess(SAVE_AS_SKILL_ACTION.savedToast)}');
  });

  it('操作 Footer 与高级设置之间使用标准 section gap（tokens.md 标准档 24px，非 magic margin）', () => {
    expect(cssSrc).toMatch(/\.vision-wizard \{[\s\S]*?margin-bottom: 24px;/);
  });
});
