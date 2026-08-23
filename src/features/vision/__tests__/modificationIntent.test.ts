import { describe, it, expect } from 'vitest';
import {
  EMPTY_MODIFICATION_DRAFT,
  MODIFICATION_CHIP_DEFS,
  buildModificationInstruction,
  clearPersonReplacement,
  clothingPolicyInstruction,
  describePerson,
  hasStructuredIntent,
  isModificationDraftEmpty,
  migrateModificationDraft,
  personHasImage,
  setPersonReplacement,
  toggleModificationDimension,
  toggleReplicationBoost,
  type ModificationDraft,
} from '../modificationIntent';
import { getVisualAnalysisMessage } from '../recreationCopy';

const empty = (): ModificationDraft => ({ ...EMPTY_MODIFICATION_DRAFT });

describe('Modification Dimension Selector（结构化维度选择器）', () => {
  it('维度 toggle：激活 → 唯一槽位；再次点击 → 取消（永远不产生重复槽位）', () => {
    let draft = empty();
    draft = toggleModificationDimension(draft, 'style');
    expect(draft.activeDimensions).toEqual(['style']);
    draft = toggleModificationDimension(draft, 'style'); // 第二次点击 = 取消
    expect(draft.activeDimensions).toEqual([]);
    draft = toggleModificationDimension(draft, 'style'); // 第三次 = 重新激活
    expect(draft.activeDimensions).toEqual(['style']);
    // 快速连点 N 次同一维度：仍只有一个槽位
    for (let i = 0; i < 5; i++) draft = toggleModificationDimension(draft, 'style');
    expect(draft.activeDimensions.filter(key => key === 'style').length).toBeLessThanOrEqual(1);
  });

  it('不同维度可同时激活（多维修改互不排斥）', () => {
    let draft = empty();
    for (const key of ['pose', 'scene', 'style'] as const) {
      draft = toggleModificationDimension(draft, key);
    }
    expect(draft.activeDimensions).toEqual(['pose', 'scene', 'style']);
  });

  it('取消「修改人物」= 整体移除人物替换（含仅因人物产生的服装策略）', () => {
    let draft = empty();
    draft = toggleModificationDimension(draft, 'subject');
    draft = setPersonReplacement(draft, { source: 'local', path: 'D:/p.png', label: 'p.png' });
    draft = { ...draft, clothingPolicy: 'use_subject_reference' };
    const cleared = toggleModificationDimension(draft, 'subject');
    expect(cleared.activeDimensions).not.toContain('subject');
    expect(cleared.person).toBeNull();
    expect(cleared.clothingPolicy).toBe('preserve_original');
  });

  it('取消「修改人物」不影响其它维度与自由文本', () => {
    let draft: ModificationDraft = { ...empty(), freeText: '背景也改成夜景' };
    draft = toggleModificationDimension(draft, 'scene');
    draft = toggleModificationDimension(draft, 'subject');
    const cleared = toggleModificationDimension(draft, 'subject');
    expect(cleared.activeDimensions).toEqual(['scene']);
    expect(cleared.freeText).toBe('背景也改成夜景');
  });

  it('「修改服装」独立维度与人物替换的服装策略共存时互不覆盖', () => {
    let draft = empty();
    draft = toggleModificationDimension(draft, 'clothing');
    const clearedPerson = clearPersonReplacement(draft);
    // clothing 维度独立激活时，移除人物不重置服装自定义
    expect(clearedPerson.activeDimensions).toEqual(['clothing']);
    expect(clearedPerson.customClothing).toBe('');
  });

  it('设置人物参考自动激活 subject 维度；移除人物参考解除 subject', () => {
    let draft = empty();
    draft = setPersonReplacement(draft, { source: 'gallery', assetId: 'a1', path: 'D:/g.png', label: '银发少女' });
    expect(draft.activeDimensions).toContain('subject');
    expect(personHasImage(draft.person)).toBe(true);
    const cleared = setPersonReplacement(draft, null);
    expect(cleared.activeDimensions).not.toContain('subject');
    expect(cleared.person).toBeNull();
  });

  it('「提高复刻度」是独立开关，不占维度槽位', () => {
    let draft = empty();
    draft = toggleReplicationBoost(draft);
    expect(draft.replicationBoost).toBe(true);
    expect(draft.activeDimensions).toEqual([]);
    draft = toggleReplicationBoost(draft);
    expect(draft.replicationBoost).toBe(false);
  });

  it('结构化意图判定：维度 / 人物 / 自定义服装 / 复刻强度任一存在即为真', () => {
    expect(hasStructuredIntent(empty())).toBe(false);
    expect(hasStructuredIntent(toggleModificationDimension(empty(), 'pose'))).toBe(true);
    expect(hasStructuredIntent(toggleReplicationBoost(empty()))).toBe(true);
    expect(hasStructuredIntent({ ...empty(), clothingPolicy: 'custom', customClothing: '黑色西装' })).toBe(true);
    expect(isModificationDraftEmpty({ ...empty(), freeText: '  ' })).toBe(true);
    expect(isModificationDraftEmpty({ ...empty(), freeText: '更亮' })).toBe(false);
  });
});

describe('合成优化器指令（自由文本 + 结构化意图合并，两者都不丢）', () => {
  it('只有自由文本时输出原文（旧协议完全兼容）', () => {
    expect(buildModificationInstruction({ ...empty(), freeText: '更梦幻一些' })).toBe('更梦幻一些');
  });

  it('自由文本 + 快捷维度合并（§56：两种信息都不能丢）', () => {
    let draft = toggleModificationDimension({ ...empty(), freeText: '背景也改成夜景' }, 'pose');
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('背景也改成夜景');
    expect(instruction).toContain('重点修改维度：动作');
  });

  it('无自由文本、纯结构化意图也可优化（Chip 单独可驱动优化）', () => {
    const draft = toggleModificationDimension(toggleModificationDimension(empty(), 'scene'), 'style');
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('重点修改维度：背景、风格');
    expect(instruction.trim()).not.toBe('');
  });

  it('风格维度只有一个槽位：换值靠覆盖（编译层不产生重复 style 行）', () => {
    const draft = toggleModificationDimension(empty(), 'style');
    const instruction = buildModificationInstruction(draft);
    expect(instruction.match(/风格/g)?.length).toBe(1);
  });
});

describe('人物替换五案例（§52：subject / clothing 语义分离的指令层保证）', () => {
  const buildFor = (freeText: string, person?: Parameters<typeof setPersonReplacement>[1], policy?: ModificationDraft['clothingPolicy']) => {
    let draft: ModificationDraft = { ...empty(), freeText };
    if (person) draft = setPersonReplacement(draft, person);
    if (policy) draft = { ...draft, clothingPolicy: policy };
    return buildModificationInstruction(draft);
  };

  it('Case 1「换成黑发男性」（无服装描述）→ subject changed，clothing 锁定沿用原图', () => {
    const instruction = buildFor('换成一个黑发男性');
    expect(instruction).toContain('换成一个黑发男性');
    // 未设置人物参考 / 服装策略 → 不输出「采用参考服装」类指令（服装默认保持原图语义）
    expect(instruction).not.toContain('使用人物参考图中的服装');
  });

  it('Case 2「换成黑发男性，穿白色西装」→ subject + clothing 同时表达', () => {
    const instruction = buildFor('换成黑发男性，穿白色西装');
    expect(instruction).toContain('穿白色西装');
  });

  it('Case 3「人物保持不变，换成红色晚礼服」→ 仅服装修改（不激活 subject）', () => {
    const instruction = buildFor('人物保持不变，衣服换成红色晚礼服');
    expect(instruction).not.toContain('人物替换');
  });

  it('Case 4 人物参考图 + 沿用原图服装 → preserve_original 指令显式', () => {
    const instruction = buildFor(
      '',
      { source: 'gallery', assetId: 'a1', path: 'D:/g.png', label: '银发少女.png' },
      'preserve_original',
    );
    expect(instruction).toContain('人物替换：使用图片库人物参考图（银发少女.png）');
    expect(instruction).toContain('身份、脸部、发型、体型');
    expect(instruction).toContain('服装处理：严格保留原图服装');
  });

  it('Case 5 人物参考图 + 使用参考人物服装 → use_subject_reference 指令显式', () => {
    const instruction = buildFor(
      '',
      { source: 'local', path: 'D:/local/ref.png' },
      'use_subject_reference',
    );
    expect(instruction).toContain('人物替换：使用本地导入人物参考图');
    expect(instruction).toContain('服装处理：使用人物参考图中的服装');
  });

  it('文字描述人物 → 无图片参考，指令走描述行', () => {
    const instruction = buildFor('', { source: 'description', description: '25 岁亚洲女性，银色短发' });
    expect(instruction).toContain('人物替换：25 岁亚洲女性，银色短发');
    expect(personHasImage({ source: 'description', description: 'x' })).toBe(false);
  });

  it('自定义服装（无人物）→ 独立服装指令', () => {
    const instruction = buildModificationInstruction({
      ...empty(),
      activeDimensions: ['clothing'],
      clothingPolicy: 'custom',
      customClothing: '黑色西装、白衬衫、无领带',
    });
    expect(instruction).toContain('服装处理：更换为指定服装——黑色西装、白衬衫、无领带');
    expect(instruction).toContain('重点修改维度：服装');
  });

  it('describePerson / clothingPolicyInstruction 边界', () => {
    expect(describePerson({ source: 'description', description: ' 描述 ' })).toBe('描述');
    expect(describePerson({ source: 'local', path: 'D:/a/b/人物.png' })).toBe('人物.png');
    expect(clothingPolicyInstruction('preserve_original', '', false)).toContain('严格保留原图服装');
    expect(clothingPolicyInstruction('custom', '', true)).toContain('由 AI 按整体意图自洽设计');
  });

  it('提高复刻度 → 复刻强度指令行', () => {
    const instruction = buildModificationInstruction(toggleReplicationBoost(empty()));
    expect(instruction).toContain('复刻强度：更贴近原图，提高复刻度');
  });
});

describe('持久化迁移（唯一槽位与来源合法性保证）', () => {
  it('旧 adjustmentInput 纯文本 → freeText；非法维度 / 未知来源被剔除', () => {
    const migrated = migrateModificationDraft(
      {
        freeText: undefined,
        activeDimensions: ['style', 'style', 'mood', 'pose'] as never,
        person: { source: 'daydream' } as never,
        clothingPolicy: 'custom' as const,
        customClothing: 'x',
        replicationBoost: 'yes' as never,
      },
      '背景换成夜景',
    );
    expect(migrated.freeText).toBe('背景换成夜景');
    expect(migrated.activeDimensions).toEqual(['style', 'pose']);
    expect(migrated.person).toBeNull();
    // 无人物 / 服装维度时非法 clothingPolicy 归默认
    expect(migrated.clothingPolicy).toBe('preserve_original');
  });

  it('person 存在但 subject 维度缺失 → 自动补齐 subject（一致性保证）', () => {
    const migrated = migrateModificationDraft({
      activeDimensions: [],
      person: { source: 'description', description: '黑发男性' },
    });
    expect(migrated.activeDimensions).toContain('subject');
  });

  it('chip 定义与文案池顺序固定（UI 展示顺序单一来源）', () => {
    expect(MODIFICATION_CHIP_DEFS.map(chip => chip.key)).toEqual(['subject', 'pose', 'scene', 'camera', 'style', 'clothing']);
    expect(getVisualAnalysisMessage(0)).toContain('…');
  });
});
