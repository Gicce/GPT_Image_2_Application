import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 人物强替换生成 payload 源码守卫（V4.0.9.1，spec §11 / §28）：
 * 多图角色链路从视觉页到 Rust 上传端必须全程贯通——
 *  视觉页 generateFromPlan（角色清单解析，mention 人物不再丢失）
 *  → carry.imageReferences（顺序 = 提交顺序）
 *  → ImageStudio i2iSources → submitSingle source_images（按序全部提交）
 *  → Rust edit_single_image（image[] multipart 按序全部上传 gpt-image-2）。
 * 源码文本断言先例见 imageTaskIsolation.test.ts / visionPromptProvenance.test.ts。
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

const visionPage = readSource('../VisionUnderstanding.tsx');
const studioPage = readSource('../ImageStudio.tsx');
const historyPage = readSource('../History.tsx');
const carryApply = readSource('../../features/vision/carryApply.ts');
const taskRunner = readSource('../../../src-tauri/src/task_runner.rs');

describe('视觉页：人物参考图真实进入 carry（mention 人物不再丢失）', () => {
  it('generateFromPlan 用 resolveGenerationImageReferences 解析有序角色清单', () => {
    expect(visionPage).toContain('resolveGenerationImageReferences({');
  });

  it('人物路径 = 面板人物图 ?? 明确 @mention 人物（origin === mention 才算数）', () => {
    expect(visionPage).toMatch(/mentionResolution\.person\?\.origin === 'mention' \? mentionResolution\.person\.path : undefined/);
  });

  it('角色清单同时喂给快照与 carry（imageReferences 双写，快照 = payload）', () => {
    expect(visionPage).toMatch(/buildGenerationProvenance\(\{[\s\S]*?imageReferences,/);
    expect(visionPage).toMatch(/personReferencePath: personPath \|\| undefined,\s*imageReferences,/);
    expect(visionPage).toContain("personReplacement: {");
    expect(visionPage).toContain('enabled: !!personPath || !!currentDraft.person');
  });

  it('开发态安全诊断日志存在且不含敏感字段（无 base64 / token / authorization）', () => {
    expect(visionPage).toContain("'[VisionGeneration]'");
    const logBlock = visionPage.slice(
      visionPage.indexOf("console.info('[VisionGeneration]'"),
      visionPage.indexOf('});', visionPage.indexOf("console.info('[VisionGeneration]'")),
    );
    expect(logBlock).not.toContain('base64');
    expect(logBlock).not.toContain('token');
  });
});

describe('ImageStudio：提交 payload 按序携带全部参考图 + 确定性指令', () => {
  it('submitSingle 的 source_images = i2iSources 路径按序映射（含模板 + 人物）', () => {
    expect(studioPage).toContain('source_images: isEdit ? i2iSources.map(item => item.path) : []');
  });

  it('carry 应用：i2iPrompt / i2iSources / i2iNegative 全部来自 resolveVisionCarryPatch（V6.2 计划图带语义角色）', () => {
    expect(studioPage).toContain('setI2iPrompt(patch.i2iPrompt)');
    // V6.2：计划参考图映射时剥离 mention role，携带 generationRole / origin / label
    expect(studioPage).toContain('updateI2iSources(patch.i2iSources.map(source => ({');
    expect(studioPage).toContain('generationRole: source.role');
    expect(studioPage).toContain('patch.i2iNegative');
  });

  it('i2i 负面词回落携带草稿（指令追加项随任务冻结，可在 History 审计）', () => {
    // V4.2.4：携带负面词在 carry 时预填 i2i 表单槽（imageEditNegative），
    // 提交时统一从表单槽读取 —— 负面词与正向词同一条 PromptDraft 链路
    expect(studioPage).toContain('if (patch.i2iNegative) setI2iNegative(patch.i2iNegative);');
    expect(studioPage).toContain('const manualNegative = isEdit ? i2iNegative : t2iNegative;');
    expect(studioPage).toContain('negative_prompt: finalNegative');
  });
});

describe('carryApply：角色清单 → 参考图 + 指令编译（纯函数层）', () => {
  it('imageReferences 是 i2iSources 的事实源（新清单优先，旧路径兼容回落）', () => {
    expect(carryApply).toContain('export function resolveCarryImageReferences');
    expect(carryApply).toContain('carry.imageReferences?.length');
  });

  it('i2iPrompt 前置 buildGenerationImageDirective；负面词追加排斥项', () => {
    expect(carryApply).toContain('buildGenerationImageDirective(directiveInput)');
    expect(carryApply).toContain('appendNegativeAddendum(negative, buildGenerationNegativeAddendum(directiveInput))');
    expect(carryApply).toContain('`${directive}\\n\\n${prompt}`');
  });
});

describe('Rust 上传端：全部 source_images 按序上传 gpt-image-2', () => {
  it('edit_single_image 对每张源图构建 multipart part（image[]），无单图截断', () => {
    expect(taskRunner).toContain('for (file_name, bytes, mime) in &image_parts');
    // V4.2 Contract Hotfix：部件名收敛到常量，契约由 Rust 侧
    // edits_form_contract_locks_text_fields_and_image_part_name 守卫
    expect(taskRunner).toContain('const EDITS_IMAGE_PART_NAME: &str = "image[]"');
    expect(taskRunner).toContain('form.part(EDITS_IMAGE_PART_NAME, part)');
    // 源图全部预读进 image_parts（模板 + 人物 + 额外参考一张不少）
    expect(taskRunner).toMatch(/for img_path in &source_images[\s\S]*?image_parts\.push/);
  });
});

describe('History：只读快照，绝不反推角色', () => {
  it('参考图角色卡来自 provenance.imageRoles + PROVENANCE_ROLE_LABELS；旧任务仅编号', () => {
    expect(historyPage).toContain('provenance?.imageRoles');
    expect(historyPage).toContain('PROVENANCE_ROLE_LABELS[role.role]');
    expect(historyPage).toContain('`参考图 ${index + 1}`');
  });

  it('执行规则摘要渲染（describeExecutionRules，最终 Prompt 之前）', () => {
    expect(historyPage).toContain('describeExecutionRules(provenance)');
    expect(historyPage).toContain('history-exec-rules');
  });

  it('用户要求唯一读取入口 = 快照 userInstruction / user_prompt_raw（不读 final_prompt）', () => {
    expect(historyPage).toContain('provenance?.userInstruction?.trim()');
  });
});
