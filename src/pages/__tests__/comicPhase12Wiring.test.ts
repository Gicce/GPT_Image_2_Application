import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

/**
 * AI 漫画 Phase 1.2 UI 接线源守卫（规格 §7~§12 Presentation Selector 起步；
 * 后续 Phase E~I 的接线断言按区段追加在本文件）。
 *
 * 锁定的规范：
 * - §8.1 展示形式必须可视化：七模板选择卡 + ComicFormPreviewMini 纯 CSS Mini Canvas
 *   缩略图（V4.2.12 §64-68 起统一预览；旧 ComicLayoutPreview 已随死代码清理删除）；
 *   禁止 Image2 生成预览、禁止文字「2x2」代替视觉图；
 * - §12.2 对白方式四卡（不只艺术名词）+ §12.1 视觉风格预设卡（promptText 入 Prompt）；
 * - §73 形式变化影响格数 → toast 提示「现有分镜需要重新规划」，不偷偷覆盖；
 * - §7 [保存为漫画技能] 资产入口；
 * - 选择动作全部走 domain（applyPresentationToProject / applyDialogueModeToProject /
 *   applyVisualStyleToProject），组件不自拼快照赋值。
 */

const page = readFileSync(resolve(__dirname, '../ComicStudio.tsx'), 'utf-8').replace(/\r\n/g, '\n');
const skillStage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicSkillStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');
const copy = readFileSync(
  resolve(__dirname, '../../../.claude/skills/cyimagepro-ui/copy.md'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('§8 展示形式可视化选择卡', () => {
  test('选择卡几何同源：previewOf 走 presentationPatchFor → normalizeComicLayout → resolveComicPresentation', () => {
    expect(skillStage).toContain('presentationPatchFor(template)');
    expect(skillStage).toContain('normalizeComicLayout({ ...skill.layout, ...presentationPatchFor(template) })');
    expect(skillStage).toContain('resolveComicPresentation(');
  });

  test('七模板全渲染 + 每卡带 页数 / 每页张数 / 总张数 / 推荐用途 / 对白适配（§8 字段清单 + V4.2.12 §67 meta）', () => {
    expect(skillStage).toContain('COMIC_PRESENTATION_TEMPLATES.map');
    // V4.2.12 §67：多页 meta 用「张/成品图」口径，单页保持「格」口径
    expect(skillStage).toContain('页 · 每页 ${preview.panelsPerPage} 张 · 共 ${preview.totalPanels} 张成品图');
    expect(skillStage).toContain('页 · 每页 ${preview.panelsPerPage} 格 · 共 ${preview.totalPanels} 格');
    expect(skillStage).toContain('{template.description}');
    expect(skillStage).toContain('对白：{template.dialogueHint}');
    // V4.2.12 §64-68：全部形式卡统一 Mini Canvas（多页 = 堆叠页 +「+N 页」，不再用带
    // 「第 N 页」绝对定位标签的老 ComicLayoutPreview）
    expect(skillStage).toContain('<ComicFormPreviewMini presentation={preview} />');
    expect(skillStage).not.toContain('<ComicLayoutPreview presentation={preview} compact />');
  });
});

describe('§12 对白方式与视觉风格', () => {
  test('四种对白方式卡（label + 一句适配说明），选择走 applyDialogueModeToProject', () => {
    expect(skillStage).toContain('COMIC_DIALOGUE_MODE_LABELS');
    expect(skillStage).toContain('COMIC_DIALOGUE_MODE_HINTS');
    expect(skillStage).toContain('applyDialogueModeToProject(project, mode)');
  });

  test('视觉风格预设卡（label + 说明 + 缩略示意），promptText 写入走 applyVisualStyleToProject', () => {
    expect(skillStage).toContain('COMIC_VISUAL_STYLE_PRESETS.map');
    expect(skillStage).toContain('selectVisualStyle(preset.promptText)');
    expect(skillStage).toContain('applyVisualStyleToProject(project, promptText)');
    expect(skillStage).toContain('styleSketch(preset.id)');
  });

  test('Step 2 主 CTA 在顶层（不埋进高级折叠），文案走 copy.md 标准叫法', () => {
    expect(skillStage).toContain('comic-stage-confirm');
    expect(skillStage).toContain('确认画面与形式，下一步');
    const confirmIndex = skillStage.indexOf('comic-stage-confirm');
    const advancedIndex = skillStage.indexOf('comic-advanced-card');
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(advancedIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeLessThan(advancedIndex);
  });
});

describe('§73 形式变化提示 / §7 资产入口', () => {
  test('格数变化 + 有活跃分镜 → toast 提示需要重新规划（stale 在 domain，不偷偷覆盖）', () => {
    expect(skillStage).toContain('applyPresentationToProject(project, template)');
    expect(skillStage).toContain('outcome.panelCountChanged && project.panels.some(panel => !panel.stale)');
    expect(skillStage).toContain('现有分镜需要重新规划');
  });

  test('[保存为漫画技能] 入口：页面 handler 走 useComicStore.saveSkill（version+1），项目快照不回写', () => {
    expect(skillStage).toContain('props.onSaveAsSkill');
    expect(page).toContain('handleSaveAsSkill');
    expect(page).toContain('useComicStore.getState().saveSkill(active.skillSnapshot)');
    // 首次入库后回写 skillId 建立溯源（快照本身不回写库）
    expect(page).toContain("updateActive(draft => ({ ...draft, skillId: draft.skillSnapshot.id }))");
  });

  test('copy.md：视觉风格预设名与「保存为漫画技能」已登记', () => {
    for (const term of ['萌系简笔', '手绘线稿', '日系清新', '低饱和插画', '复古印刷', '保存为漫画技能']) {
      expect(copy).toContain(term);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 1.2-F（§13.2 Rail 视觉信息 / §14~§16 Character Hero Card）
// ---------------------------------------------------------------------------

const characterStage = readFileSync(
  resolve(__dirname, '../../features/comic/components/ComicCharacterStage.tsx'), 'utf-8',
).replace(/\r\n/g, '\n');

describe('§13.2 Rail 视觉信息（Persistent Project Summary）', () => {
  test('本期方案卡带视觉条：Mini Canvas（V4.2.12 §64-68 统一预览）+ 主角参考图缩略（V4.2.11 §D：不再展示「第一张效果」）', () => {
    expect(page).toContain('comic-rail-visuals');
    expect(page).toContain('<ComicFormPreviewMini presentation={resolveComicPresentation(active.skillSnapshot)} />');
    expect(page).not.toContain('<ComicLayoutPreview');
    expect(page).toContain('railHeroRef && railThumbs.hero');
    expect(page).toContain('主角参考图');
    // P0-6：锚点/第一张效果是内部概念，禁止出现在用户语言
    expect(page).not.toContain('第一张效果');
  });

  test('缩略只读本地（readThumbnail），不存在生图 / 复制调用', () => {
    const railSlice = page.slice(page.indexOf('railHeroRef'), page.indexOf('comic-rail-rows'));
    expect(railSlice).toContain('api.readThumbnail(path)');
    expect(railSlice).not.toContain('readImageData');
    expect(railSlice).not.toContain('importImagesToLibrary');
  });
});

describe('§15/§16 Character Hero Card（信息分层 + 参考图视觉中心）', () => {
  test('Hero 结构：大图 figure（comic-hero-figure/comic-hero-thumb）+ 名字/定位/一句话设定', () => {
    expect(characterStage).toContain('comic-hero-figure');
    expect(characterStage).toContain('comic-hero-thumb');
    expect(characterStage).toContain('comic-hero-name">{character.name}');
    expect(characterStage).toContain('comic-hero-role">{character.role}');
    expect(characterStage).toContain('comic-hero-summary');
  });

  test('§15 高级内容默认折叠：固定特征 / 外观 / 负面约束进 details，不散落在默认区', () => {
    const advancedIndex = characterStage.indexOf('comic-character-advanced');
    expect(advancedIndex).toBeGreaterThan(-1);
    const foldSlice = characterStage.slice(advancedIndex, advancedIndex + 900);
    for (const literal of ['跨格不变：', '默认服装：', '禁止：', '外观：']) {
      expect(foldSlice).toContain(literal);
    }
    // 默认区不再直接铺特征行（旧三行 muted 文案已移入折叠）
    const defaultZone = characterStage.slice(
      characterStage.indexOf('comic-hero-head'),
      characterStage.indexOf('comic-character-advanced'),
    );
    expect(defaultZone).not.toContain('跨格不变：');
    expect(defaultZone).not.toContain('禁止：');
  });

  test('§16 参考图元信息：来源标签 + 资产 ID + 过期横幅紧贴大图', () => {
    const figureSlice = characterStage.slice(
      characterStage.indexOf('comic-hero-figure'),
      characterStage.indexOf('comic-character-facts'),
    );
    expect(figureSlice).toContain('来源：{refSourceLabel(character.referenceImage)}');
    expect(figureSlice).toContain('comic-ref-stale-banner');
    expect(figureSlice).toContain('重新生成');
    expect(figureSlice).toContain('从图库换图');
  });
});
