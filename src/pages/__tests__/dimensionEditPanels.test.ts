import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pageSrc = readFileSync(resolve(__dirname, '../VisionUnderstanding.tsx'), 'utf-8');
const panelSrc = readFileSync(resolve(__dirname, '../../features/vision/DimensionEditPanel.tsx'), 'utf-8');
const clothingSrc = readFileSync(resolve(__dirname, '../../features/vision/ClothingChangePanel.tsx'), 'utf-8');
const personSrc = readFileSync(resolve(__dirname, '../../features/vision/PersonReplacementPanel.tsx'), 'utf-8');
const mappingSrc = readFileSync(resolve(__dirname, '../../features/vision/ReferenceMapping.tsx'), 'utf-8');
const regionSrc = readFileSync(resolve(__dirname, '../../features/vision/region/RegionEditorPanel.tsx'), 'utf-8');

describe('V6.5 已勾选维度必须有可配置内容', () => {
  it('动作 / 背景 / 镜头 / 风格全部渲染 DimensionEditPanel', () => {
    expect(pageSrc).toContain("(['pose', 'scene', 'camera', 'style'] as const).map");
    expect(pageSrc).toContain('<DimensionEditPanel');
    for (const title of ['动作更改', '背景更改', '镜头更改', '风格更改']) expect(panelSrc).toContain(title);
    expect(panelSrc).toContain('onPickGallery');
    expect(panelSrc).toContain('onPickLocal');
  });

  it('维度文字要求回写 freeText，参考图进入 extraImageRefs 与图库/本地入口', () => {
    expect(pageSrc).toContain('writeDimensionRequirement');
    expect(pageSrc).toContain('setDimensionReference');
    expect(pageSrc).toContain("setGalleryPurpose('dimension-reference')");
    expect(pageSrc).toContain('api.selectImageFile()');
  });

  it('V6.8 人物三来源锚定在人物卡下方整列宽（不进卡内宽度计算，边框归卡根）', () => {
    expect(mappingSrc).toContain('{sourceControls && <div className="vision-person-map-source-row">{sourceControls}</div>}');
    // 来源行在人物卡之后（卡片内部不再有 sourceControls）
    expect(mappingSrc.indexOf('vision-person-map-source-row')).toBeGreaterThan(mappingSrc.indexOf('vision-person-map-card is-person'));
    // 三种卡片形态（图片 / 文字 / 空态）内部都不再渲染来源入口（切片止于来源行注释）
    const cardBlock = mappingSrc.slice(mappingSrc.indexOf('hasImage && person ?'), mappingSrc.indexOf('{/* 来源入口'));
    expect(cardBlock).not.toContain('sourceControls');
  });

  it('V6.8 服装减法版：来源三选一 + 仅自定义时的服装参考与描述 + 多人单行', () => {
    expect(clothingSrc).toContain('clothingPolicy === \'custom\' && (');
    expect(clothingSrc).toContain('{CLOTHING_POLICY.referenceLabel}');
    expect(clothingSrc).toContain('{CLOTHING_POLICY.multiLabel}');
    expect(clothingSrc).toContain('{CLOTHING_POLICY.multiButton}');
    expect(clothingSrc).toContain('onPickReferenceGallery');
    expect(clothingSrc).toContain('onPickReferenceLocal');
    expect(clothingSrc).toContain('onRemoveReference');
    expect(personSrc).toContain('多人处理');
    expect(personSrc).toContain('管理多人映射');
    expect(pageSrc).toContain('openPurpose={regionEditorPurpose}');
    expect(regionSrc).toContain('createRegion({ shape, replaceType: pendingPurpose })');
    expect(regionSrc).toContain('setExpandedId(created.id)');
  });

  it('V6.8 §四 区域替换是素材替换的第三个子面板（自带头部 + 添加入口 + 计数）', () => {
    expect(pageSrc.indexOf('<RegionEditorPanel')).toBeGreaterThan(pageSrc.indexOf('vision-adjust-box'));
    expect(regionSrc).toContain('data-testid="region-panel"');
    expect(regionSrc).toContain('vision-subpanel-head');
    expect(regionSrc).toContain('vision-subpanel-title">区域替换');
    expect(regionSrc).toContain('data-testid="vision-region-add"');
    expect(regionSrc).toContain('data-testid="vision-region-count"');
    expect(regionSrc).toContain('添加替换区域');
  });
});
