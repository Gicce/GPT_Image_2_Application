import { describe, expect, it } from 'vitest';
import { buildReplacementSummary, REPLACEMENT_SUMMARY_LABELS } from '../replacementRules';
import type { PersonReplacement } from '../modificationIntent';

const imagePerson: PersonReplacement = { source: 'gallery', assetId: 'a1', path: 'D:/imgs/p.png', label: 'p.png' };
const descriptionPerson: PersonReplacement = { source: 'description', description: '25 岁亚洲女性，银色短发' };

describe('人物替换「当前替换规则」摘要（真实配置动态派生）', () => {
  it('无人物 → null（不渲染，绝不写死）', () => {
    expect(buildReplacementSummary({ person: null, clothingPolicy: 'preserve_original' })).toBeNull();
  });

  it('图片人物 + 原图服装：替换←@人物参考，服装/构图/背景/风格←@原图', () => {
    const model = buildReplacementSummary({ person: imagePerson, clothingPolicy: 'preserve_original' })!;
    expect(model.rows).toHaveLength(3);
    const [replace, clothing, keep] = model.rows;
    expect(replace.items).toEqual(['主体人物', '面部 / 五官', '发型']);
    expect(replace.source).toBe(REPLACEMENT_SUMMARY_LABELS.personToken);
    expect(clothing.source).toBe(REPLACEMENT_SUMMARY_LABELS.originalToken);
    expect(keep.items).toEqual(['构图', '背景', '风格']);
    expect(keep.source).toBe(REPLACEMENT_SUMMARY_LABELS.originalToken);
  });

  it('启用「修改动作 / 修改背景」：出现 modify 行，且背景从保留行剔除', () => {
    const model = buildReplacementSummary({
      person: imagePerson,
      clothingPolicy: 'use_subject_reference',
      activeDimensions: ['subject', 'pose', 'scene'],
    })!;
    const modifyRows = model.rows.filter(row => row.kind === 'modify');
    expect(modifyRows.map(row => row.items.join())).toEqual(['动作', '背景']);
    expect(modifyRows[0].source).toBe(REPLACEMENT_SUMMARY_LABELS.poseModifyNote);
    expect(modifyRows[1].source).toBe(REPLACEMENT_SUMMARY_LABELS.sceneModifyNote);
    const keep = model.rows.find(row => row.kind === 'keep')!;
    expect(keep.items).toEqual(['构图', '风格']); // 背景已开放修改，从保留行剔除；风格未启用仍保留
  });

  it('未启用维度时不出现 modify 行（保留行完整）', () => {
    const model = buildReplacementSummary({ person: imagePerson, clothingPolicy: 'preserve_original' })!;
    expect(model.rows.filter(row => row.kind === 'modify')).toHaveLength(0);
  });

  it('图片人物 + 人物服装：服装←@人物参考', () => {
    const model = buildReplacementSummary({ person: imagePerson, clothingPolicy: 'use_subject_reference' })!;
    const clothing = model.rows.find(row => row.kind === 'clothing')!;
    expect(clothing.source).toBe(REPLACEMENT_SUMMARY_LABELS.personToken);
  });

  it('自定义服装：服装←自定义（有描述 / 未填写两态）', () => {
    const filled = buildReplacementSummary({ person: imagePerson, clothingPolicy: 'custom', customClothing: '黑色西装' })!;
    expect(filled.rows.find(row => row.kind === 'clothing')!.source).toBe('自定义');
    const empty = buildReplacementSummary({ person: imagePerson, clothingPolicy: 'custom', customClothing: '' })!;
    expect(empty.rows.find(row => row.kind === 'clothing')!.source).toBe('自定义（未填写）');
  });

  it('文字描述人物：替换来源显示「人物描述」（不是 @token）', () => {
    const model = buildReplacementSummary({ person: descriptionPerson, clothingPolicy: 'preserve_original' })!;
    const replace = model.rows.find(row => row.kind === 'replace')!;
    expect(replace.source).toBe(REPLACEMENT_SUMMARY_LABELS.personDescription);
  });
});
