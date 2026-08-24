import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * V4.0.9 @图片引用 + 人物替换业务卡（源码契约测试，先例见 visionSimplification.test.ts）：
 * - 当前任务图片池唯一来源（buildVisionContextImages）驱动 @ 弹层与优化器 payload；
 * - mention 是真实图片引用（mentions 侧车表绑定 assetId/path），不是纯文本补全；
 * - 弹层 / 上下选择 / Esc 是纯视图操作（组件内不触碰 store / semanticRevision）；
 * - 人物替换面板区分「画面模板」与「替换人物」双区；
 * - 优化器调用真实携带 imageReferences（模板图 + 人物图 + @引用图）。
 */
const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf8');
const inputSrc = readFileSync(resolve(__dirname, '../../features/vision/IntentMentionInput.tsx'), 'utf8');
const panelSrc = readFileSync(resolve(__dirname, '../../features/vision/PersonReplacementPanel.tsx'), 'utf8');
const mappingSrc = readFileSync(resolve(__dirname, '../../features/vision/ReferenceMapping.tsx'), 'utf8');
const pickerSrc = readFileSync(resolve(__dirname, '../../features/vision/CharacterSourcePicker.tsx'), 'utf8');
const clothingSrc = readFileSync(resolve(__dirname, '../../features/vision/ClothingSourceControl.tsx'), 'utf8');
const summarySrc = readFileSync(resolve(__dirname, '../../features/vision/ReplacementSummary.tsx'), 'utf8');
const IMAGE_MENTION_PICK_GALLERY = 'IMAGE_MENTION.popupPickGallery';

describe('当前任务图片池（统一 selector，禁止各自维护图片数组）', () => {
  test('页面用 buildVisionContextImages 聚合：主参考图 + 人物替换 + 图库附加 + 本任务生成结果', () => {
    expect(pageSrc).toContain('buildVisionContextImages');
    expect(pageSrc).toContain('generatedResults');
    expect(pageSrc).toContain('source_task_id === visionTaskId');
    expect(pageSrc).toContain('extraImageRefs');
  });

  test('池按当前任务隔离：生成结果只取本视觉任务（source_task_id 过滤），不串其它对话', () => {
    const poolBlock = pageSrc.slice(pageSrc.indexOf('const generatedResults'), pageSrc.indexOf('const contextPool'));
    expect(poolBlock).toContain('source_task_id === visionTaskId');
    expect(poolBlock).toContain(`(t.task_type === 'generate' || t.task_type === 'edit')`);
  });
});

describe('@ 图片 Mention（真实引用，不是纯文本）', () => {
  test('输入组件接入：IntentMentionInput 替换裸 textarea（id 保持 vision-adjust-input）', () => {
    expect(pageSrc).toContain('<IntentMentionInput');
    expect(pageSrc).toContain('id="vision-adjust-input"');
    expect(pageSrc).not.toMatch(/<textarea[^>]*id="vision-adjust-input"/);
  });

  test('mention 绑定真实图片（mentions 侧车表：assetId / path / role；插入走语义通道）', () => {
    expect(pageSrc).toContain('onMentionsChange={onMentionsChange}');
    expect(pageSrc).toContain('mentions={modificationDraft.mentions}');
    expect(inputSrc).toContain('assetId');
    expect(inputSrc).toContain('commitInsert');
  });

  test('弹层候选来自当前任务池（pool 属性），支持「从图片库选择…」加入当前任务', () => {
    expect(pageSrc).toContain('pool={contextPool}');
    expect(pageSrc).toContain("setGalleryPurpose('mention')");
    expect(inputSrc).toContain(IMAGE_MENTION_PICK_GALLERY);
  });

  test('IME 安全：组合态不处理弹层键盘（禁止为 @ 强上富文本编辑器）', () => {
    expect(inputSrc).toContain('isComposing');
    expect(inputSrc).toContain('<textarea');
    expect(inputSrc).not.toContain('contentEditable');
  });

  test('IME 组合态弹层不闪烁：compositionstart / end 显式守卫，组合中不检测触发', () => {
    expect(inputSrc).toContain('composingRef');
    expect(inputSrc).toContain('onCompositionStart');
    expect(inputSrc).toContain('onCompositionEnd');
    expect(inputSrc).toMatch(/if \(!composingRef\.current\)/);
  });

  test('caret-aware：点击 / 方向键移动光标后按新位置重检触发（handleSelect 再检测）', () => {
    expect(inputSrc).toMatch(/const handleSelect[\s\S]*?setTrigger\(detectMentionTrigger\(textarea\.value, textarea\.selectionStart\)\)/);
  });

  test('点击弹层外部只关闭浮层、不拦截该次点击（mousedown 关闭且无 preventDefault）', () => {
    const outsideBlock = inputSrc.slice(
      inputSrc.indexOf('点击弹层外部'),
      inputSrc.indexOf('const closePopup'),
    );
    expect(outsideBlock).toContain("document.addEventListener('mousedown'");
    expect(outsideBlock).not.toContain('preventDefault');
    // 弹层内 / textarea 内的点击不误关
    expect(outsideBlock).toContain('popupRef.current?.contains');
  });

  test('弹层贴近视口底部时向上翻转（is-flipped）', () => {
    expect(inputSrc).toContain('is-flipped');
    expect(inputSrc).toContain('getBoundingClientRect');
  });

  test('弹层是纯视图操作：组件不写 workspace store、不触发语义修改（UI-only 不 dirty）', () => {
    expect(inputSrc).not.toContain('useVisionWorkspaceStore');
    expect(inputSrc).not.toContain('setModificationDraft');
    expect(inputSrc).not.toContain('setRecreation');
    // 视图状态（弹层开关 / 选中索引）全部组件内 useState
    expect(inputSrc).toContain('useState<{ start: number; query: string } | null>(null)');
  });

  test('引用 chips：hover 看图 + 点击进全局 ImageViewer + × 移除（不是纯文本路径）', () => {
    expect(inputSrc).toContain('vision-mention-chip');
    expect(inputSrc).toContain('openMentionViewer');
    expect(inputSrc).toContain('useImageViewerStore');
    expect(inputSrc).toContain('removeMention');
  });
});

describe('人物替换业务卡（V4.1 视觉映射：画面模板 → 替换人物）', () => {
  test('面板含业务卡头（已启用徽章 + 业务说明 + 移除按钮为 secondary 非 danger）', () => {
    expect(panelSrc).toContain('vision-person-business-head');
    expect(panelSrc).toContain('PERSON_REPLACEMENT.businessBadge');
    expect(panelSrc).toContain('PERSON_REPLACEMENT.businessDesc');
    expect(panelSrc).not.toContain('vision-btn-danger');
  });

  test('视觉映射主体：模板卡与人物卡并排 + 中央替换箭头（谁被换成谁一眼可见）', () => {
    expect(mappingSrc).toContain('vision-person-mapping');
    expect(mappingSrc).toContain('vision-person-map-arrow');
    expect(mappingSrc).toContain('PERSON_REPLACEMENT.templateToken');
    expect(mappingSrc).toContain('PERSON_REPLACEMENT.personCardTitle');
    expect(mappingSrc).toContain('openTemplateViewer');
    expect(mappingSrc).toContain('openPersonViewer');
  });

  test('命名统一：模板卡显示 @原图，人物卡标题「人物参考」+ 文件名小字（不再是文件名当主标题）', () => {
    expect(mappingSrc).toMatch(/@\{PERSON_REPLACEMENT\.templateToken\}/);
    expect(mappingSrc).toContain('vision-person-map-file');
    expect(mappingSrc).toContain('vision-person-map-name');
  });

  test('空态 / 已选态二选一：未选人物只显示选择空态，已选显示卡片 + 更换（禁止同时大面积出现）', () => {
    expect(mappingSrc).toContain('vision-person-map-card is-empty');
    expect(mappingSrc).toContain('personEmptyAction');
    expect(panelSrc).toContain('showSourcePicker');
    // 已选图片人物时来源选择区隐藏，由「更换人物」进入选择态
    expect(panelSrc).toMatch(/picking \|\| !hasImageRef/);
  });

  test('人物来源收成 Segmented Control（图片库 / 本地导入 / 文字描述）', () => {
    expect(pickerSrc).toContain('vision-person-seg');
    expect(pickerSrc).toContain('role="tab"');
    expect(pickerSrc).toContain('PERSON_REPLACEMENT.sourceGallery');
    expect(pickerSrc).toContain('PERSON_REPLACEMENT.sourceLocal');
    expect(pickerSrc).toContain('PERSON_REPLACEMENT.sourceDescription');
  });

  test('服装来源收成 Segmented Control：一行动态说明 + 仅自定义展开输入', () => {
    expect(clothingSrc).toContain('vision-person-seg');
    expect(clothingSrc).toContain('role="radiogroup"');
    expect(clothingSrc).toContain("clothingPolicy === 'custom' &&");
    expect(clothingSrc).toContain('CLOTHING_POLICY.preserveOriginal');
    expect(clothingSrc).toContain('CLOTHING_POLICY.useSubjectReference');
  });

  test('当前替换规则 Summary：由真实配置动态派生（buildReplacementSummary），绝不写死', () => {
    expect(summarySrc).toContain('buildReplacementSummary');
    expect(summarySrc).toContain('clothingPolicy');
    expect(summarySrc).toContain('if (!model) return null');
  });

  test('页面给面板传模板（当前参考图）与更换模板图回调（更换会重置分析有明确提示）', () => {
    expect(pageSrc).toContain('template={sourcePath ? { path: sourcePath');
    expect(pageSrc).toContain('onTemplateChange=');
    expect(mappingSrc).toContain('PERSON_REPLACEMENT.templateChangeNote');
  });
});

describe('自然语言 / mention → 面板建议态（不偷偷覆盖）', () => {
  test('建议条只在面板人物为空时出现（显式面板选择 > mention > 推断）', () => {
    expect(pageSrc).toContain('showMentionSuggestion');
    expect(pageSrc).toMatch(/!modificationDraft\.person/);
    expect(pageSrc).toContain('applyMentionSuggestion');
    expect(pageSrc).toContain('MENTION_SUGGESTION.apply');
  });

  test('建议应用走正常语义通道（onPersonChange），忽略态只是视图', () => {
    expect(pageSrc).toContain('setDismissedSuggestion');
    const applyBlock = pageSrc.slice(pageSrc.indexOf('const applyMentionSuggestion'), pageSrc.indexOf('const buildOptimizerImageReferences'));
    expect(applyBlock).toContain('onPersonChange');
  });
});

describe('优化器 payload（双图真实进入 multimodal）', () => {
  test('优化调用携带 imageReferences（模板图 + 人物图 + @引用图），不只传文本', () => {
    expect(pageSrc).toContain('buildOptimizerImageReferences');
    expect(pageSrc).toContain('imageReferences,');
    expect(pageSrc).toContain('OptimizerImageReference');
  });

  test('合成指令带双图上下文（模板标签 / 人物 mention）', () => {
    expect(pageSrc).toContain('buildModificationInstruction(wstore.modificationDraft, {');
    expect(pageSrc).toContain('resolution.template ? { label: resolution.template.label }');
  });
});
