import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V6 模板复用 Skill 链路结构守卫（源码文本断言，项目内无 DOM 测试环境）：
 * - 工坊入口：template_reuse 草稿必须走 TemplateSkillUseDialog（禁止回落摘要编译器）；
 * - 重建链路：Recipe → buildProjectFromSkillRecipe → adoptProject → hydrate → 视觉工作台
 *   （hydrate 必须在 adoptProject 之后——页面挂载不再自动恢复工作区）；
 * - 生成门禁：generateFromPlan 编译后立即执行 Skill Origin Guard（阻断式，不静默降级）；
 * - 对比视图：Prompt 来源抽屉携带 originSkill 基线 + 实况全文 + 实况合同块。
 */

const workshopSrc = readFileSync(resolve(__dirname, '../SkillWorkshop.tsx'), 'utf-8');
const dialogSrc = readFileSync(resolve(__dirname, '../../features/skillWorkshop/TemplateSkillUseDialog.tsx'), 'utf-8');
const visionSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const drawerSrc = readFileSync(resolve(__dirname, '../../features/vision/skills/SkillTraceDrawer.tsx'), 'utf-8');
const creatorSrc = readFileSync(resolve(__dirname, '../../features/skillWorkshop/SkillCreatorDialog.tsx'), 'utf-8');

describe('工坊入口：模板复用 Skill 分流', () => {
  test('useMySkill 先 normalizeUserSkillDraft；template_reuse 分支打开使用弹窗后直接 return（不走 compileSkillPrompt）', () => {
    expect(workshopSrc).toContain('normalizeUserSkillDraft');
    const useMySkillBlock = workshopSrc.slice(workshopSrc.indexOf('const useMySkill'), workshopSrc.indexOf('const compiled = useMemo'));
    expect(useMySkillBlock).toMatch(/draft\.skillType === 'template_reuse' && draft\.recipe/);
    expect(useMySkillBlock).toMatch(/setUseDialogDraft\(draft\);\s*\n\s*return;/);
    const branchIndex = useMySkillBlock.indexOf("draft.skillType === 'template_reuse'");
    const genericIndex = useMySkillBlock.indexOf('userSkillToPackage');
    expect(branchIndex).toBeLessThan(genericIndex);
  });

  test('页面渲染 TemplateSkillUseDialog（模板复用使用弹窗唯一挂载点）', () => {
    expect(workshopSrc).toMatch(/<TemplateSkillUseDialog draft=\{useDialogDraft\}/);
  });

  test('我的技能列表区分类型：载入草稿判定 skillType（Rust 列表无该列）', () => {
    expect(workshopSrc).toMatch(/skillTypes\[item\.id\] \?\? 'generic'/);
    expect(workshopSrc).toContain("skillType === 'template_reuse' ? '模板复用 · 从保存的完整方案重建（合同不降级）'");
  });

  test('创作器展示类型徽标 + Recipe 冻结说明（通用 / 模板复用 UI 区分）', () => {
    expect(creatorSrc).toContain('skill-type-badge is-template">模板复用 Skill');
    expect(creatorSrc).toContain('通用流程 Skill');
    expect(creatorSrc).toMatch(/data-testid="skill-recipe-note"/);
    expect(creatorSrc).toContain('完整方案快照（含模板图本地路径）只保存在本机');
  });
});

describe('使用弹窗：槽位绑定 + Recipe 重建同源链路', () => {
  test('重建走 buildProjectFromSkillRecipe；写入 store 前先 flushPersist（不覆盖未保存项目）', () => {
    expect(dialogSrc).toContain('buildProjectFromSkillRecipe');
    expect(dialogSrc).toMatch(/store\.flushPersist\(\)/);
    expect(dialogSrc.indexOf('flushPersist')).toBeLessThan(dialogSrc.indexOf('adoptProject'));
  });

  test('adoptProject 之后必须 hydrateWorkspaceFromActive（挂载不自动恢复工作区），再导航视觉页', () => {
    const openBlock = dialogSrc.slice(dialogSrc.indexOf('const openReuseProject'), dialogSrc.indexOf('\n  return ('));
    const adoptIndex = openBlock.indexOf('adoptProject');
    const hydrateIndex = openBlock.indexOf('hydrateWorkspaceFromActive');
    const navigateIndex = openBlock.indexOf("cyimage-navigate");
    expect(adoptIndex).toBeGreaterThanOrEqual(0);
    expect(hydrateIndex).toBeGreaterThan(adoptIndex);
    expect(navigateIndex).toBeGreaterThan(hydrateIndex);
    expect(openBlock).toContain("page: 'vision'");
  });

  test('模板图不可读即阻断执行（绝不带着坏模板直接生成或进工作台）', () => {
    // V6.2 双执行方式：快速生成（direct）+ 高级调整（workbench）都受模板校验门禁
    expect(dialogSrc).toMatch(/disabled=\{busy \|\| repairRunning \|\| templateCheck !== 'ok'\}/);
    expect(dialogSrc).toMatch(/disabled=\{busy \|\| repairRunning \|\| templateCheck !== 'ok' \|\| !directReady\}/);
    expect(dialogSrc).toContain('模板图不可读');
  });

  test('人物槽位复用共享 ImageLibraryPicker（唯一图库选择器）+ 本地双入口', () => {
    expect(dialogSrc).toMatch(/<ImageLibraryPicker/);
    expect(dialogSrc).toContain('api.selectImageFile()');
  });

  test('弹窗规范：背景滚动锁定 + Escape 让位图库选择器（galleryOpenRef）', () => {
    expect(dialogSrc).toMatch(/document\.body\.style\.overflow = 'hidden'/);
    expect(dialogSrc).toMatch(/document\.body\.style\.overflow = previousOverflow/);
    expect(dialogSrc).toMatch(/e\.key === 'Escape' && !galleryOpenRef\.current/);
  });
});

describe('视觉页：生成门禁 + Prompt 对比视图', () => {
  test('generateFromPlan 编译后立即执行 Skill Origin Guard（阻断式；先于任何生成提交）', () => {
    expect(visionSrc).toContain('validateSkillOriginContractCoverage(project, compiled');
    const guardIndex = visionSrc.indexOf('const originErrors = validateSkillOriginContractCoverage');
    const compileIndex = visionSrc.indexOf('const compiled = mergeFinalGenerationPrompt', visionSrc.indexOf('generateFromPlan'));
    expect(guardIndex).toBeGreaterThan(compileIndex);
    expect(visionSrc).toMatch(/toastError\(originErrors\[0\], '生成前需处理'\)/);
  });

  test('openPromptSource 冻结实况全文 + 合同块；抽屉接通 originSkill / requiredBlocks / 对比卡', () => {
    expect(visionSrc).toMatch(/setLivePromptText\(compiled\.prompt\)/);
    expect(visionSrc).toMatch(/setLiveCompilerSections\(compiled\.sections\)/);
    expect(visionSrc).toMatch(/originSkill=\{activeProject\?\.originSkill \?\? null\}/);
    expect(visionSrc).toMatch(/originRequiredBlocks=\{originRequiredBlocks\}/);
    expect(visionSrc).toContain('requiredContractBlocks(');
  });

  test('对比卡复用 computePromptDiff 唯一实现；结构对比区分「降级缺失」与「按需未编译」', () => {
    expect(drawerSrc).toContain("import { computePromptDiff } from '../promptDiff'");
    expect(drawerSrc).toMatch(/data-testid="skill-origin-compare"/);
    expect(drawerSrc).toContain('skillOriginSectionLabel');
    expect(drawerSrc).toContain('按需未编译');
    expect(drawerSrc).toContain('Skill Origin Guard 阻断');
  });
});
