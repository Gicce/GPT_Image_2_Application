/**
 * V6.3 Person Replacement UI V2（§28-§36）结构守卫：
 *
 *  - 人物替换与服装更改独立成卡，人物来源入口进入右侧人物卡；
 *  - 紧凑映射卡：缩略图 150px（120-160px 区间）横排，不再是 260px 大图竖排铺开；
 *  - 缩略图点击进全局 ImageViewer（大图交给查看器，卡片只做识别）；
 *  - 文案：更换人物 → 更换人物参考；人物来源 → 身份来源（服装来源并列同组）。
 * 测试环境无 DOM：源码结构守卫（readFileSync + 结构断言），与 visionMentionUi 同式。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERSON_REPLACEMENT } from '../../features/vision/recreationCopy';

const panelSrc = readFileSync(new URL('../../features/vision/PersonReplacementPanel.tsx', import.meta.url), 'utf-8');
const mappingSrc = readFileSync(new URL('../../features/vision/ReferenceMapping.tsx', import.meta.url), 'utf-8');
const pickerSrc = readFileSync(new URL('../../features/vision/CharacterSourcePicker.tsx', import.meta.url), 'utf-8');
const clothingSrc = readFileSync(new URL('../../features/vision/ClothingChangePanel.tsx', import.meta.url), 'utf-8');
const pageCss = readFileSync(new URL('../VisionUnderstanding.css', import.meta.url), 'utf-8');

describe('V6.4：人物替换与服装更改分层', () => {
  it('人物卡保留主体 / 执行范围 / 替换强度，合同控件零删减', () => {
    expect(PERSON_REPLACEMENT.groupSubject).toBe('主体');
    expect(PERSON_REPLACEMENT.groupScope).toBe('执行范围');
    expect(PERSON_REPLACEMENT.groupStrength).toBe('替换强度');
    for (const token of ['groupSubject', 'groupScope', 'groupStrength']) {
      expect(panelSrc).toContain(`PERSON_REPLACEMENT.${token}`);
    }
    expect(panelSrc).toContain('vision-person-group-label');
    expect(panelSrc.match(/<section className="vision-person-group"/g)?.length).toBe(3);
  });

  it('人物三种来源移入右侧人物卡，继续调用原图库 / 本地导入 / 文字描述回调', () => {
    expect(panelSrc).toContain('sourceControls={(');
    expect(panelSrc).toContain('<CharacterSourcePicker');
    expect(mappingSrc).toContain('{sourceControls}');
    for (const marker of [
      'galleryChangeButton', 'localChangeButton', 'descriptionChangeButton',
      'onGalleryPick', 'onLocalPick', 'onDescriptionChange',
    ]) expect(pickerSrc).toContain(marker);
  });

  it('服装设置独立展示，仍复用原 ClothingSourceControl 与合同回调', () => {
    expect(panelSrc).not.toContain('<ClothingSourceControl');
    expect(clothingSrc).toContain('<ClothingSourceControl');
    expect(clothingSrc).toContain('onClothingPolicyChange');
    expect(clothingSrc).toContain('onCustomClothingChange');
  });

  it('scopeGroupHoldsContract：执行范围 = 替换范围 + 身份应用（合同 V2 控件不丢）', () => {
    const scopeGroup = panelSrc.slice(
      panelSrc.indexOf('PERSON_REPLACEMENT.groupScope'),
      panelSrc.indexOf('PERSON_REPLACEMENT.groupStrength'),
    );
    expect(scopeGroup).toContain('替换范围');
    expect(scopeGroup).toContain('身份应用');
    expect(scopeGroup).toContain('applyIdentityTo');
    // 替换强度独立分组（strict / balanced / natural）
    const strengthGroup = panelSrc.slice(panelSrc.indexOf('PERSON_REPLACEMENT.groupStrength'));
    expect(strengthGroup).toContain('STRENGTH_OPTIONS');
  });
});

describe('V6.3 §30-§32：紧凑映射卡（预览 120-160px）', () => {
  it('compactThumbnails：缩略图 140px 高 / 150px 宽（区间内），不再是 260px 大图', () => {
    const thumbRule = pageCss.match(/\.vision-person-map-thumb img\s*\{[^}]*\}/s)![0];
    expect(thumbRule).toContain('max-height: 140px');
    expect(thumbRule).not.toContain('260px');
    expect(pageCss).toContain('flex: 0 0 150px');
    // 卡片横排：缩略图左 + 信息右（不再上图下文竖排）
    expect(pageCss).toMatch(/\.vision-person-map-card\s*\{[^}]*flex-direction:\s*row/s);
    // 空态也保持横向：提示在左、三种来源在右，修复上下错位
    expect(pageCss).toMatch(/\.vision-person-map-card\.is-empty\s*\{[^}]*flex-direction:\s*row/s);
    // V6.8 §三：来源菜单在卡下方整列宽（不再有卡内 actions 列，不参与卡内宽度计算）
    expect(pageCss).not.toContain('.vision-person-map-actions');
    expect(pageCss).toContain('.vision-person-map-source-row');
  });

  it('thumbnailsOpenGlobalViewer：点击缩略图进全局 ImageViewer（大图交给查看器）', () => {
    expect(mappingSrc).toContain('useImageViewerStore');
    expect(mappingSrc).toContain('openTemplateViewer');
    expect(mappingSrc).toContain('openPersonViewer');
    expect(mappingSrc).toContain('点击在内置图片查看器中查看');
    expect(pageCss).toContain('cursor: zoom-in');
  });
});

describe('V6.4：文案与行为收口', () => {
  it('人物更换动作由人物卡下方整列宽的三个明确来源按钮承担（V6.8 §三）', () => {
    expect(mappingSrc).toContain('vision-person-map-source-row');
    expect(pickerSrc).toContain('galleryChangeButton');
    expect(pickerSrc).toContain('localChangeButton');
    expect(pickerSrc).toContain('descriptionChangeButton');
  });

  it('selectionFlowUnchanged：空态、已选更换与文字描述流程都可达', () => {
    expect(mappingSrc).toContain('vision-person-map-card is-empty');
    expect(mappingSrc).toContain('{sourceControls}');
    expect(pickerSrc).toContain('vision-person-description');
    expect(pickerSrc).toContain('aria-pressed={activeTab ===');
    // 契约控件可达性保持（radiogroup / radio / aria-checked）
    expect(panelSrc).toContain('role="radiogroup"');
    expect(panelSrc).toContain('aria-checked');
  });
});
