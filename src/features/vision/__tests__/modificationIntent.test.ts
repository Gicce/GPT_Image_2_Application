import { describe, it, expect } from 'vitest';
import {
  EMPTY_MODIFICATION_DRAFT,
  MODIFICATION_CHIP_DEFS,
  buildModificationInstruction,
  clearPersonReplacement,
  clothingPolicyInstruction,
  detectExplicitModificationDimensions,
  describePerson,
  dimensionDirectiveInstruction,
  hasStructuredIntent,
  isModificationDraftEmpty,
  migrateModificationDraft,
  personHasImage,
  readDimensionRequirement,
  setPersonReplacement,
  toggleModificationDimension,
  toggleReplicationBoost,
  writeDimensionRequirement,
  type ModificationDraft,
} from '../modificationIntent';
import { getVisualAnalysisMessage } from '../recreationCopy';

const empty = (): ModificationDraft => ({ ...EMPTY_MODIFICATION_DRAFT });

describe('Prompt 自动勾选（纯前端辅助）', () => {
  it('只勾选用户明确要求修改的维度，保持项不误选', () => {
    expect(detectExplicitModificationDimensions(
      '把人物换成银发女生，穿黑色夹克，背景改成夜晚街道，动作保持不变',
    )).toEqual(['subject', 'clothing', 'scene']);
  });

  it('镜头、风格和动作可组合识别；空文本不产生选择', () => {
    expect(detectExplicitModificationDimensions('动作改成奔跑，镜头切换成俯拍，整体改为水彩风格'))
      .toEqual(['pose', 'camera', 'style']);
    expect(detectExplicitModificationDimensions('')).toEqual([]);
  });
});

describe('维度配置卡与自由文本同源', () => {
  it('动作 / 背景要求按独立行写入、更新和移除，不覆盖用户其它原话', () => {
    let text = '把人物换成银发女生';
    text = writeDimensionRequirement(text, 'pose', '双手抱胸站立');
    text = writeDimensionRequirement(text, 'scene', '夜晚霓虹街道');
    expect(readDimensionRequirement(text, 'pose')).toBe('双手抱胸站立');
    expect(readDimensionRequirement(text, 'scene')).toBe('夜晚霓虹街道');
    expect(text).toContain('把人物换成银发女生');
    text = writeDimensionRequirement(text, 'pose', '挥手奔跑');
    expect(text.match(/动作要求：/g)).toHaveLength(1);
    expect(readDimensionRequirement(text, 'pose')).toBe('挥手奔跑');
    expect(writeDimensionRequirement(text, 'scene', '')).not.toContain('背景要求：');
  });

  it('维度参考图职责进入合成修改指令', () => {
    const draft: ModificationDraft = {
      ...empty(),
      activeDimensions: ['pose', 'scene', 'style', 'clothing'],
      clothingPolicy: 'custom',
      customClothing: '参照服装图',
      extraImageRefs: [
        { path: 'D:/pose.png', label: '动作图', purpose: 'pose' },
        { path: 'D:/bg.png', label: '背景图', purpose: 'scene' },
        { path: 'D:/style.png', label: '风格图', purpose: 'style' },
        { path: 'D:/clothes.png', label: '服装图', purpose: 'clothing' },
      ],
    };
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('动作参考图：以「动作图」');
    expect(instruction).toContain('背景参考图：以「背景图」');
    expect(instruction).toContain('风格参考图：以「风格图」');
    expect(instruction).toContain('服装参考图：以「服装图」');
  });
});

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

  it('风格维度只有一个槽位：换值靠覆盖（重点修改维度行不产生重复 style 项）', () => {
    const draft = toggleModificationDimension(empty(), 'style');
    const instruction = buildModificationInstruction(draft);
    const dimLine = instruction.match(/重点修改维度：([^\n]*)/)?.[1] ?? '';
    expect(dimLine).toBe('风格');
  });

  it('启用「修改动作」→ must-change 指令（未写具体动作也绝不退化成保持原样）', () => {
    const draft = toggleModificationDimension(empty(), 'pose');
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('动作修改（已启用）');
    expect(instruction).toContain('必须生成与原图明确不同的新动作');
    expect(instruction).toContain('禁止沿用原图姿势');
  });

  it('启用「修改背景」→ 背景内容必须变化但保持画面风格', () => {
    const draft = toggleModificationDimension(empty(), 'scene');
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('背景修改（已启用）');
    expect(instruction).toContain('背景内容不再照搬原图');
    expect(instruction).toContain('保持原图整体画面风格与动漫氛围');
  });

  it('三维同时启用（人物 / 动作 / 背景）→ 三类修改语义同时进入指令', () => {
    let draft = empty();
    for (const key of ['subject', 'pose', 'scene'] as const) {
      draft = toggleModificationDimension(draft, key);
    }
    draft = setPersonReplacement(draft, { source: 'gallery', assetId: 'a1', path: 'D:/p.png', label: 'p.png' });
    draft = { ...draft, clothingPolicy: 'use_subject_reference' };
    const instruction = buildModificationInstruction(draft, { template: { label: '原图' } });
    expect(instruction).toContain('人物替换（强制条件）：使用图片库人物参考图（p.png）');
    expect(instruction).toContain('动作修改（已启用）');
    expect(instruction).toContain('背景修改（已启用）');
    expect(instruction).toContain('服装处理：使用人物参考图中的服装');
    // 模板行不得再写死「仅替换主体人物」——动作 / 背景已开放修改
    expect(instruction).toContain('已启用的修改维度（动作、背景）按各自修改指令执行');
    expect(instruction).not.toContain('仅替换主体人物，其余视觉结构尽量沿用模板图');
  });

  it('纯文本主体修改（无人物参考）→ subject 也有 must-change 语义', () => {
    const draft = toggleModificationDimension(empty(), 'subject');
    const instruction = buildModificationInstruction(draft);
    expect(instruction).toContain('人物修改（已启用）');
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
    expect(instruction).toContain('人物替换（强制条件）：使用图片库人物参考图（银发少女.png）');
    expect(instruction).toContain('不得保留原图（画面模板）原人物的脸部身份或面部特征');
    expect(instruction).toContain('服装处理：严格保留原图（画面模板）服装');
    expect(instruction).toContain('保留服装 ≠ 保留人物');
  });

  it('Case 5 人物参考图 + 使用参考人物服装 → use_subject_reference 指令显式', () => {
    const instruction = buildFor(
      '',
      { source: 'local', path: 'D:/local/ref.png' },
      'use_subject_reference',
    );
    expect(instruction).toContain('人物替换（强制条件）：使用本地导入人物参考图');
    expect(instruction).toContain('服装处理：使用人物参考图中的服装');
  });

  it('双图工作流指令（V4.0.9）：人物 + 模板上下文 → 画面模板行显式（图二风格 + 图三人）', () => {
    let draft: ModificationDraft = { ...empty(), freeText: '把 @原图 的人物换成 @人物参考' };
    draft = setPersonReplacement(draft, { source: 'gallery', assetId: 'a2', path: 'D:/person.png', label: '人物参考.png' });
    draft = {
      ...draft,
      mentions: [
        { id: 'm1', path: 'D:/source.png', label: '原图', token: '原图', role: 'source_reference' },
        { id: 'm2', assetId: 'a2', path: 'D:/person.png', label: '人物参考', token: '人物参考', role: 'person_replacement_reference' },
      ],
    };
    const instruction = buildModificationInstruction(draft, { template: { label: '原图' } });
    expect(instruction).toContain('把 @原图 的人物换成 @人物参考');
    expect(instruction).toContain('图片引用：@原图=随消息附上的对应图片（原图）');
    expect(instruction).toContain('人物替换（强制条件）：使用图片库人物参考图（人物参考.png）');
    expect(instruction).toContain('画面模板：以「原图」为画面模板');
    expect(instruction).toContain('延续其画风、视觉氛围、构图与背景关系');
    expect(instruction).toContain('服装处理：严格保留原图（画面模板）服装');
  });

  it('面板为空但文本 @引用人物 → 人物来源 mention 指令行（不与面板冲突）', () => {
    const draft: ModificationDraft = {
      ...empty(),
      freeText: '把 @图二 的人物换成 @图三',
      mentions: [
        { id: 'm1', path: 'D:/fig2.png', label: '图二', token: '图二', role: 'source_reference' },
        { id: 'm2', path: 'D:/fig3.png', label: '图三', token: '图三', role: 'person_replacement_reference' },
      ],
    };
    const instruction = buildModificationInstruction(draft, {
      template: { label: '图二' },
      personMention: { label: '图三' },
    });
    expect(instruction).toContain('人物来源=@图三（随消息附上的图片）');
    expect(instruction).toContain('画面模板：以「图二」为画面模板');
  });

  it('personReplacementWithReplicationBoostStillUsesPersonReference：复刻强度不得覆盖人物替换', () => {
    let draft: ModificationDraft = setPersonReplacement(
      empty(),
      { source: 'gallery', assetId: 'a1', path: 'D:/p.png', label: 'p.png' },
    );
    draft = toggleReplicationBoost(draft);
    const instruction = buildModificationInstruction(draft);
    // 复刻强度行存在且显式限定「不作用于人物身份」
    expect(instruction).toContain('复刻强度');
    expect(instruction).toContain('不作用于人物身份——人物替换不受复刻强度影响');
    // 强替换语义同在（不被复刻强度弱化）
    expect(instruction).toContain('人物替换（强制条件）');
    expect(instruction).toContain('不得保留原图（画面模板）原人物的脸部身份或面部特征');
  });

  it('forcedPersonActionBackgroundAllReachCompiledPrompt：人物 / 动作 / 背景显式启用全部进入指令', () => {
    let draft: ModificationDraft = empty();
    for (const key of ['subject', 'pose', 'scene'] as const) {
      draft = toggleModificationDimension(draft, key);
    }
    draft = setPersonReplacement(draft, { source: 'local', path: 'D:/ref.png' });
    const instruction = buildModificationInstruction(draft);
    expect(draft.activeDimensions).toEqual(expect.arrayContaining(['subject', 'pose', 'scene']));
    expect(instruction).toContain('人物替换（强制条件）');
    expect(instruction).toContain('动作修改（已启用）');
    expect(instruction).toContain('必须生成与原图明确不同的新动作');
    expect(instruction).toContain('背景修改（已启用）');
    expect(instruction).toContain('背景内容不再照搬原图');
    // 动作 / 背景进「重点修改维度」行；subject 由人物替换块表达（不重复列维度）
    expect(instruction).toContain('重点修改维度：动作、背景');
    expect(draft.activeDimensions).toEqual(['subject', 'pose', 'scene']);
  });

  it('孤儿 mention（文本已删除 token）不进入指令绑定行', () => {
    const draft: ModificationDraft = {
      ...empty(),
      freeText: '只改成夜景',
      mentions: [
        { id: 'm1', path: 'D:/fig2.png', label: '图二', token: '图二', role: 'source_reference' },
      ],
    };
    const instruction = buildModificationInstruction(draft);
    expect(instruction).not.toContain('图片引用：');
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
    expect(clothingPolicyInstruction('preserve_original', '', false)).toContain('严格保留原图（画面模板）服装');
    expect(clothingPolicyInstruction('custom', '', true)).toContain('由 AI 按整体意图自洽设计');
  });

  it('服装策略 = 人物服装 → 指令包含服装继承强约束（不仅换脸）', () => {
    const instruction = clothingPolicyInstruction('use_subject_reference', '', true);
    expect(instruction).toContain('使用人物参考图中的服装');
    expect(instruction).toContain('不仅替换脸部');
    expect(instruction).toContain('继承该人物的服装与造型特征');
  });

  it('dimensionDirectiveInstruction：subject 无指令（由人物替换块表达），其余维度均有 must-change 行', () => {
    expect(dimensionDirectiveInstruction('subject')).toBeNull();
    for (const key of ['pose', 'scene', 'camera', 'style', 'clothing'] as const) {
      const directive = dimensionDirectiveInstruction(key);
      expect(directive).toBeTruthy();
      expect(directive).toContain('（已启用）');
    }
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
