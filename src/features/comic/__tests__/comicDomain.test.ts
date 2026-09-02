/**
 * AI 漫画 Phase 1 领域测试（对应 docs/ai-comic/04-TEST-MATRIX.md）：
 * - normalize 矩阵：LLM / 旧形状 → 合法领域对象，单字段异常不毁整卡
 * - Skill Patch：白名单、slotId 定位、结构共享（验收 C）
 * - 快照冻结（验收 M/N 前置）、生成门禁（验收 D / J）、Story stale（验收 G）、对白纯本地（验收 I 数据层）
 */
import { describe, expect, it } from 'vitest';
import {
  COMIC_PANEL_COUNT_RANGE,
  normalizeComicCharacter,
  normalizeComicConsistency,
  normalizeComicDialogue,
  normalizeComicPanel,
  normalizeComicProject,
  normalizeComicSkill,
  normalizeComicStory,
  normalizeText,
  normalizeTextArray,
  validateComicSkill,
} from '../normalize';
import { applyComicFinalPages, comicStoryboardReadiness,
  applyComicCharacterPatches,
  applyComicSkillPatches,
  applyStoryToProject,
  attachCharacterReference,
  bindSlotCharacter,
  comicCharacterConfirmationState,
  comicPanelSeriesReadiness,
  confirmComicCharacter,
  createCharacterSnapshot,
  createSkillSnapshot,
  dialoguesOfPanel,
  lockAnchor,
  lockComicCharacter,
  normalizeComicSkillPatch,
  removeDialogue,
  resolveSlotCharacter,
  unbindSlot,
  unlockComicCharacter,
  upsertCharacterSnapshot,
  upsertDialogue,
} from '../domain';
import type {
  ComicCharacter,
  ComicCharacterStatus,
  ComicDialogue,
  ComicPanel,
  ComicProject,
  ComicSkill,
  ComicStory,
} from '../types';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSkill(): ComicSkill {
  return normalizeComicSkill({
    id: 'skill-1',
    name: '职场吐槽四格',
    comicForm: '四格漫画',
    version: 3,
    source: 'ai_draft',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
    characterSlots: [
      { slotId: 'hero', name: '主角', required: true, displayRule: '全身出场，表情夸张' },
      { slotId: 'reporter', name: '记者', required: false, displayRule: '仅手部与麦克风，不露脸' },
    ],
  });
}

function makeCharacter(status: ComicCharacterStatus = 'confirmed'): ComicCharacter {
  const character = normalizeComicCharacter({
    id: 'char-1',
    name: '汤圆',
    status,
    immutableTraits: ['黄白毛色', '圆脸', '小耳朵'],
  });
  expect(character).not.toBeNull();
  return character as ComicCharacter;
}

/** 锁定 + 参考图齐备的角色（Phase 1.1 起必选角色门禁 = locked 且有参考图）。 */
function makeLockedCharacterWithReference(): ComicCharacter {
  return {
    ...makeCharacter('locked'),
    referenceImage: { path: '/refs/char-1.png', label: '汤圆参考图' },
  };
}

function makeProject(options: {
  character?: ComicCharacter | null;
  bound?: boolean;
  anchor?: boolean;
  panels?: ComicPanel[];
} = {}): ComicProject {
  const skill = makeSkill();
  const character = options.character === undefined ? makeLockedCharacterWithReference() : options.character;
  const project = normalizeComicProject({
    id: 'project-1',
    name: '第一期',
    stage: 'story_ready',
    skillSnapshot: skill,
    characterSnapshots: character ? [character] : [],
    characterBindings:
      options.bound === false || !character ? {} : { hero: character.id },
    panels:
      options.panels ?? [
        { id: 'panel-1', order: 0, scene: '办公室清晨，主角盯着一摞文件' },
        { id: 'panel-2', order: 1, scene: '主角抱头崩溃' },
      ],
    dialogues: [],
    consistency: options.anchor
      ? {
        anchor: {
          panelId: 'panel-1',
          path: '/comic/anchor.png',
          imageId: 'img-anchor',
          taskId: 'task-anchor',
          lockedAt: '2026-08-30T01:00:00.000Z',
        },
        characterReferences: [],
      }
      : undefined,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:00:00.000Z',
  });
  expect(project).not.toBeNull();
  return project as ComicProject;
}

function makeStory(): ComicStory {
  const story = normalizeComicStory({ title: '周一例会', beats: ['铺垫', '冲突', '反转'] });
  expect(story).not.toBeNull();
  return story as ComicStory;
}

function makeDialogue(overrides: Record<string, unknown> = {}): ComicDialogue {
  const dialogue = normalizeComicDialogue({
    id: 'dlg-1',
    panelId: 'panel-1',
    text: '又是一周！',
    ...overrides,
  });
  expect(dialogue).not.toBeNull();
  return dialogue as ComicDialogue;
}

// ---------------------------------------------------------------------------
// normalizeText / normalizeTextArray
// ---------------------------------------------------------------------------

describe('comic normalizeText', () => {
  it('直取字符串并 trim', () => {
    expect(normalizeText('  四格漫画 ')).toBe('四格漫画');
  });

  it('数组按「；」合并（LLM 常见漂移）', () => {
    expect(normalizeText(['搞笑', ' ', '毒舌'])).toBe('搞笑；毒舌');
  });

  it('object 只读描述键，其余落默认', () => {
    expect(normalizeText({ description: '手绘风' })).toBe('手绘风');
    expect(normalizeText({ foo: 'bar' })).toBe('');
    expect(normalizeText(null, 'fallback')).toBe('fallback');
  });
});

describe('comic normalizeTextArray', () => {
  it('单字符串按分隔符拆为数组', () => {
    expect(normalizeTextArray('黄白毛色；圆脸\n小耳朵')).toEqual(['黄白毛色', '圆脸', '小耳朵']);
  });

  it('数组内 object 采集字符串叶子并去空', () => {
    expect(normalizeTextArray([{ description: '圆脸' }, '  ', '小耳朵', 42])).toEqual(['圆脸', '小耳朵']);
  });
});

// ---------------------------------------------------------------------------
// ComicSkill normalize
// ---------------------------------------------------------------------------

describe('normalizeComicSkill', () => {
  it('空输入落全默认（字段级恢复起点）', () => {
    const skill = normalizeComicSkill({});
    expect(skill.name).toBe('未命名漫画');
    expect(skill.comicForm).toBe('四格漫画');
    expect(skill.layout.panelCount).toBe(2);
    expect(skill.characterSlots).toEqual([]);
    expect(skill.referenceStrategy).toEqual({ useAnchorAsStyle: true, characterRefs: 'required' });
  });

  it('noText 铁律：任何输入都不允许关掉（规格 §15）', () => {
    const skill = normalizeComicSkill({ generationRules: { noText: false } });
    expect(skill.generationRules.noText).toBe(true);
    const skill2 = normalizeComicSkill({ generationRules: { noText: 'no' } });
    expect(skill2.generationRules.noText).toBe(true);
  });

  it('非法槽位被剔除，合法槽位保留', () => {
    const skill = normalizeComicSkill({
      characterSlots: [
        { slotId: 'hero', name: '主角' },
        { slotId: '', name: '空 id' },
        { name: '缺 id' },
        'garbage',
      ],
    });
    expect(skill.characterSlots).toHaveLength(1);
    expect(skill.characterSlots[0]).toMatchObject({ slotId: 'hero', name: '主角', required: true });
  });

  it('panelCount 钳制在 1..12', () => {
    expect(normalizeComicSkill({ layout: { panelCount: 99 } }).layout.panelCount)
      .toBe(COMIC_PANEL_COUNT_RANGE.max);
    expect(normalizeComicSkill({ layout: { panelCount: 0 } }).layout.panelCount)
      .toBe(COMIC_PANEL_COUNT_RANGE.min);
    expect(normalizeComicSkill({ layout: { panelCount: '4' } }).layout.panelCount).toBe(4);
  });

  it('未知 enum 落 fallback，不抛错', () => {
    const skill = normalizeComicSkill({
      source: 'hacker',
      layout: { arrangement: 'spiral', panelCount: 5 },
      exportDefaults: { canvasRatio: '21:9' },
    });
    expect(skill.source).toBe('ai_draft');
    // Phase 1.2 §70：arrangement 非法时按格数确定性推导；5 格无标准形状 → custom
    expect(skill.layout.arrangement).toBe('custom');
    expect(skill.exportDefaults.canvasRatio).toBe('3:4');
  });
});

describe('validateComicSkill', () => {
  it('未命名 / 无槽位 / 无必选槽位均报错', () => {
    const empty = normalizeComicSkill({});
    const errors = validateComicSkill(empty);
    expect(errors).toContain('缺少漫画名称');
    expect(errors).toContain('缺少角色槽位');

    const noRequired = normalizeComicSkill({
      name: '有名',
      characterSlots: [{ slotId: 'a', name: '配角', required: false }],
    });
    expect(validateComicSkill(noRequired)).toContain('缺少必选主角槽位');

    expect(validateComicSkill(makeSkill())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Character / Story / Panel / Dialogue normalize
// ---------------------------------------------------------------------------

describe('normalizeComicCharacter', () => {
  it('缺名字整卡丢弃', () => {
    expect(normalizeComicCharacter({ description: '无名的某人' })).toBeNull();
  });

  it('参考图缺 path 不生成 referenceImage，其余字段保留', () => {
    const character = normalizeComicCharacter({
      id: 'c', name: '汤圆', referenceImage: { label: '没了 path' },
    });
    expect(character?.referenceImage).toBeUndefined();
    expect(character?.name).toBe('汤圆');
  });

  it('参考图带 path 完整保留', () => {
    const character = normalizeComicCharacter({
      name: '汤圆',
      referenceImage: { path: '/assets/tangyuan.png', assetId: 'a1', label: '定妆照' },
    });
    expect(character?.referenceImage).toEqual({
      path: '/assets/tangyuan.png', assetId: 'a1', label: '定妆照',
    });
  });
});

describe('normalizeComicStory', () => {
  it('标题与节拍全空 → null（不可恢复）', () => {
    expect(normalizeComicStory({})).toBeNull();
    expect(normalizeComicStory('garbage')).toBeNull();
  });

  it('有节拍无标题落默认标题，endingType 归一', () => {
    const story = normalizeComicStory({ beats: ['铺垫'], endingType: 'unknown' });
    expect(story?.title).toBe('本期漫画');
    expect(story?.endingType).toBe('twist');
  });
});

describe('normalizeComicPanel', () => {
  it('缺 scene 丢弃；order 钳制；stale 显式标记', () => {
    expect(normalizeComicPanel({ id: 'p', order: 3 })).toBeNull();
    const panel = normalizeComicPanel({ scene: '开场', order: -5, stale: true });
    expect(panel?.order).toBe(0);
    expect(panel?.stale).toBe(true);
    expect(panel?.generationStatus).toBe('pending');
  });

  it('imageAsset 缺 path 丢弃但 compiledPrompt 保留', () => {
    const panel = normalizeComicPanel({
      scene: '中景', imageAsset: { imageId: 'i' }, compiledPrompt: '简笔…',
    });
    expect(panel?.imageAsset).toBeUndefined();
    expect(panel?.compiledPrompt).toBe('简笔…');
  });
});

describe('normalizeComicDialogue', () => {
  it('缺 text / panelId 丢弃', () => {
    expect(normalizeComicDialogue({ panelId: 'p1' })).toBeNull();
    expect(normalizeComicDialogue({ text: '台词' })).toBeNull();
  });

  it('坐标钳制 0..1（V4.2.13 §8：>1 = 百分比刻度证据 → /100；负值夹 0），字号钳制 10..72，enum 归一', () => {
    const dialogue = normalizeComicDialogue({
      panelId: 'p1', text: '嗯？', position: { x: 7, y: -3 },
      fontStyle: { size: 999 }, alignment: 'justify', bubbleStyle: 'wave',
    });
    // 7 在归一化域不可能出现 → 视为 7%（百分比刻度）→ 0.07，而不是钳到 1 跳角
    expect(dialogue?.position).toEqual({ x: 0.07, y: 0 });
    expect(dialogue?.fontStyle.size).toBe(72);
    expect(dialogue?.alignment).toBe('center');
    expect(dialogue?.bubbleStyle).toBe('rounded');
    // 超 100 的百分比（420%）夹回 1；NaN 回中点
    const overflow = normalizeComicDialogue({
      panelId: 'p1', text: '嗯？', position: { x: 420, y: Number.NaN },
    });
    expect(overflow?.position).toEqual({ x: 1, y: 0.5 });
  });
});

// ---------------------------------------------------------------------------
// Consistency / Project normalize
// ---------------------------------------------------------------------------

describe('normalizeComicConsistency', () => {
  it('非对象落 undefined；anchor 缺 path 丢弃但参数兜底', () => {
    expect(normalizeComicConsistency(null)).toBeUndefined();
    const profile = normalizeComicConsistency({
      anchor: { panelId: 'p1' }, characterReferences: 'garbage',
    });
    expect(profile?.anchor).toBeUndefined();
    expect(profile?.characterReferences).toEqual([]);
    expect(profile?.generationParams).toEqual({ size: '1024x1024', quality: 'auto', format: 'png' });
  });

  it('anchor 完整保留，参考数组逐项清洗', () => {
    const profile = normalizeComicConsistency({
      anchor: { panelId: 'p1', path: 'a.png', imageId: 'i', taskId: 't', lockedAt: '' },
      characterReferences: [
        { characterId: 'c1', path: 'r1.png', label: '主角参考' },
        { characterId: 'c2', label: '缺 path' },
      ],
    });
    expect(profile?.anchor).toMatchObject({ panelId: 'p1', path: 'a.png' });
    expect(profile?.characterReferences).toEqual([
      { characterId: 'c1', path: 'r1.png', label: '主角参考' },
    ]);
  });
});

describe('normalizeComicProject', () => {
  it('缺 skillSnapshot 整卡不可恢复 → null（项目必须带 Skill 快照）', () => {
    expect(normalizeComicProject({ id: 'p', name: '无快照' })).toBeNull();
  });

  it('绑定表清洗 + 非法 panels/dialogues 剔除 + consistency 归一', () => {
    const project = normalizeComicProject({
      skillSnapshot: makeSkill(),
      characterBindings: { hero: 'char-1', reporter: '', ghost: null },
      panels: [{ scene: '有效' }, { id: 'bad' }, 'garbage'],
      dialogues: [{ panelId: 'p', text: '有效' }, { panelId: 'p' }],
      consistency: { anchor: { panelId: 'p1' } },
    });
    expect(project?.characterBindings).toEqual({ hero: 'char-1' });
    expect(project?.panels).toHaveLength(1);
    expect(project?.dialogues).toHaveLength(1);
    expect(project?.consistency?.anchor).toBeUndefined();
    expect(project?.stage).toBe('skill_draft');
  });
});

// ---------------------------------------------------------------------------
// Skill Patch（验收 C）
// ---------------------------------------------------------------------------

describe('normalizeComicSkillPatch', () => {
  it('白名单外字段丢弃', () => {
    expect(normalizeComicSkillPatch({ field: 'id', value: 'hijack' })).toBeNull();
    expect(normalizeComicSkillPatch({ field: 'source', value: 'preset' })).toBeNull();
    expect(normalizeComicSkillPatch({ field: '../../etc', value: 1 })).toBeNull();
    expect(normalizeComicSkillPatch('garbage')).toBeNull();
  });

  it('characterSlot.* 必须带 slotId', () => {
    expect(normalizeComicSkillPatch({ field: 'characterSlot.displayRule', value: 'x' })).toBeNull();
    const patch = normalizeComicSkillPatch({
      field: 'characterSlot.displayRule', value: 'x', slotId: 'reporter',
    });
    expect(patch).toMatchObject({ field: 'characterSlot.displayRule', slotId: 'reporter' });
  });
});

describe('applyComicSkillPatches（验收 C：只动相关字段，其余引用相等）', () => {
  it('单个标量补丁：新对象，但未触及分支保持引用相等', () => {
    const skill = makeSkill();
    const { skill: next, applied } = applyComicSkillPatches(skill, [
      { field: 'humorStyle', value: '冷幽默', reason: '用户要求更冷' },
    ]);
    expect(next.humorStyle).toBe('冷幽默');
    expect(applied).toEqual(['humorStyle']);
    expect(next).not.toBe(skill);
    expect(next.intent).toBe(skill.intent);
    expect(next.layout).toBe(skill.layout);
    expect(next.characterSlots).toBe(skill.characterSlots);
    expect(next.generationRules).toBe(skill.generationRules);
    expect(next.referenceStrategy).toBe(skill.referenceStrategy);
  });

  it('嵌套补丁 layout.panelCount：layout 分支重建，兄弟分支保持引用', () => {
    const skill = makeSkill();
    const { skill: next } = applyComicSkillPatches(skill, [
      { field: 'layout.panelCount', value: 6 },
    ]);
    expect(next.layout.panelCount).toBe(6);
    expect(next.layout).not.toBe(skill.layout);
    expect(next.layout.arrangement).toBe(skill.layout.arrangement);
    expect(next.intent).toBe(skill.intent);
    expect(next.characterSlots).toBe(skill.characterSlots);
  });

  it('characterSlot 补丁只重建目标槽位，其他槽位引用相等（记者不露脸案例）', () => {
    const skill = makeSkill();
    const { skill: next, applied } = applyComicSkillPatches(skill, [
      { field: 'characterSlot.displayRule', slotId: 'reporter', value: '仅手部 + 麦克风，永远不露脸' },
    ]);
    expect(applied).toEqual(['characterSlot.displayRule(reporter)']);
    expect(next.characterSlots).not.toBe(skill.characterSlots);
    expect(next.characterSlots[0]).toBe(skill.characterSlots[0]);
    expect(next.characterSlots[1]).not.toBe(skill.characterSlots[1]);
    expect(next.characterSlots[1].displayRule).toBe('仅手部 + 麦克风，永远不露脸');
    expect(next.visualStyle).toBe(skill.visualStyle);
  });

  it('未知 slotId / 非法 enum 值 / 空值进入 ignored，不改源', () => {
    const skill = makeSkill();
    const { skill: next, applied, ignored } = applyComicSkillPatches(skill, [
      { field: 'characterSlot.displayRule', slotId: 'ghost', value: 'x' },
      { field: 'layout.arrangement', value: 'spiral' },
      { field: 'visualStyle', value: '' },
      { field: 'promptTemplate', value: '有效补丁' },
    ]);
    expect(applied).toEqual(['promptTemplate']);
    expect(ignored).toEqual(['characterSlot.displayRule', 'layout.arrangement', 'visualStyle']);
    expect(next.layout.arrangement).toBe(skill.layout.arrangement);
    expect(next.promptTemplate).toBe('有效补丁');
  });

  it('数组分隔符字符串归一为数组，布尔默认语义正确', () => {
    const skill = makeSkill();
    const { skill: next } = applyComicSkillPatches(skill, [
      { field: 'generationRules.negativeConstraints', value: '乱码文字；水印' },
      { field: 'generationRules.environmentTextAllowed', value: 'yes' },
    ]);
    expect(next.generationRules.negativeConstraints).toEqual(['乱码文字', '水印']);
    expect(next.generationRules.environmentTextAllowed).toBe(false);
  });

  it('空补丁列表原样返回（引用相等，无副作用）', () => {
    const skill = makeSkill();
    const result = applyComicSkillPatches(skill, []);
    expect(result.skill).toBe(skill);
    expect(result.applied).toEqual([]);
    const garbage = applyComicSkillPatches(skill, 'not-array');
    expect(garbage.skill).toBe(skill);
  });
});

// ---------------------------------------------------------------------------
// 快照（验收 M/N 前置：项目冻结，改库不回写）
// ---------------------------------------------------------------------------

describe('createSkillSnapshot / createCharacterSnapshot', () => {
  it('深拷贝：改源不回写快照，改快照不影响源', () => {
    const skill = makeSkill();
    const snapshot = createSkillSnapshot(skill);
    skill.name = '改了名字';
    skill.characterSlots[0].name = '改了槽位';
    expect(snapshot.name).toBe('职场吐槽四格');
    expect(snapshot.characterSlots[0].name).toBe('主角');

    const character = makeCharacter();
    const charSnapshot = createCharacterSnapshot(character);
    charSnapshot.immutableTraits.push('新增特征');
    expect(character.immutableTraits).toEqual(['黄白毛色', '圆脸', '小耳朵']);
  });
});

// ---------------------------------------------------------------------------
// 生成门禁（验收 D / J）
// ---------------------------------------------------------------------------

describe('comicCharacterConfirmationState（验收 D）', () => {
  it('必选槽位未绑定 → 不通过', () => {
    const state = comicCharacterConfirmationState(makeProject({ bound: false }));
    expect(state.ready).toBe(false);
    expect(state.blockers.some((item) => item.includes('未绑定'))).toBe(true);
  });

  it('角色仍为 draft → 不通过', () => {
    const state = comicCharacterConfirmationState(makeProject({ character: makeCharacter('draft') }));
    expect(state.ready).toBe(false);
    expect(state.blockers.some((item) => item.includes('尚未确认'))).toBe(true);
  });

  it('Phase 1.1 语义：confirmed 不放行（必选必须锁定）；locked 有参考图通过；locked 缺参考图拦截', () => {
    const confirmed = comicCharacterConfirmationState(makeProject({ character: makeCharacter('confirmed') }));
    expect(confirmed.ready).toBe(false);
    expect(confirmed.blockers.some((item) => item.includes('未锁定'))).toBe(true);

    const lockedWithRef = makeProject({ character: makeLockedCharacterWithReference() });
    expect(comicCharacterConfirmationState(lockedWithRef).ready).toBe(true);

    const lockedNoRef = makeProject({ character: makeCharacter('locked') });
    const state = comicCharacterConfirmationState(lockedNoRef);
    expect(state.ready).toBe(false);
    expect(state.blockers.some((item) => item.includes('缺少参考图'))).toBe(true);
  });

  it('绑定失效（快照被移除）→ 拦截', () => {
    const project = makeProject();
    const broken = { ...project, characterSnapshots: [] };
    const state = comicCharacterConfirmationState(broken);
    expect(state.ready).toBe(false);
    expect(state.blockers.some((item) => item.includes('绑定失效'))).toBe(true);
  });
});

describe('comicPanelSeriesReadiness（验收 J）', () => {
  it('角色就绪但未锁 Anchor → 拦截并提示首格', () => {
    const state = comicPanelSeriesReadiness(makeProject({ anchor: false }));
    expect(state.ready).toBe(false);
    expect(state.blockers).toContain('第一格尚未确认（已开启「生成第一格后暂停确认」）');
  });

  it('Anchor 锁定后通过', () => {
    expect(comicPanelSeriesReadiness(makeProject({ anchor: true })).ready).toBe(true);
  });

  it('skipAnchor 显式跳过（fallback 流）且无分镜仍拦截', () => {
    const project = makeProject({ anchor: false, panels: [] });
    const skipped = comicPanelSeriesReadiness(project, { skipAnchor: true });
    expect(skipped.blockers).not.toContain('第一格尚未确认');
    expect(skipped.blockers).toContain('缺少分镜');
  });
});

describe('comicStoryboardReadiness（V4.2.11 §E 分镜门禁）', () => {
  function storyboardProject(panelCount: number, panels: ComicPanel[]): ComicProject {
    const base = makeProject({ anchor: true, panels });
    const next = normalizeComicProject({
      ...base,
      story: {
        title: '周一例会', topic: '例会', summary: '又延期', characterIds: ['char-1'],
        beats: ['a', 'b', 'c', 'd'], endingType: 'twist', panelCount,
      },
    });
    expect(next).not.toBeNull();
    return next!;
  }

  it('分镜铺满本期计划格数 → ready（四宫格 4 格全 valid）', () => {
    const project = storyboardProject(4, [0, 1, 2, 3].map(index =>
      normalizeComicPanel({ id: `p-${index}`, order: index, scene: `场景${index}` })!));
    expect(comicStoryboardReadiness(project).ready).toBe(true);
  });

  it('分镜不足计划格数 → 拦截并给出缺格数（优先按本期 story.panelCount）', () => {
    const project = storyboardProject(4, [
      normalizeComicPanel({ id: 'p-0', order: 0, scene: '开场' })!,
      normalizeComicPanel({ id: 'p-1', order: 1, scene: '发展' })!,
    ]);
    const state = comicStoryboardReadiness(project);
    expect(state.ready).toBe(false);
    expect(state.blockers).toContain('分镜还缺 2 格（本期共 4 格）');
  });

  it('stale 旧格不计入铺满；无分镜 → 缺少分镜', () => {
    const empty = makeProject({ anchor: true, panels: [] });
    expect(comicStoryboardReadiness(empty).blockers).toContain('缺少分镜');
    const staleOnly = makeProject({ anchor: true, panels: [
      { id: 's-0', order: 0, scene: '旧格', stale: true } as ComicPanel,
    ] });
    expect(comicStoryboardReadiness(staleOnly).blockers).toContain('缺少分镜');
  });
});

// ---------------------------------------------------------------------------
// Story 应用（验收 G）与 stale（规格 §42）
// ---------------------------------------------------------------------------

describe('applyComicFinalPages（V4.2.11 §F 组合漫画页面）', () => {
  it('写入整页资产；空数组清除记录', () => {
    const project = makeProject({ anchor: true });
    const withPages = applyComicFinalPages(project, [{
      page: 0, path: 'C:/lib/final.png', imageId: 'img-final',
      panelIds: ['panel-1', 'panel-2'], composedAt: '2026-09-02T00:00:00.000Z',
    }]);
    expect(withPages.finalPages).toHaveLength(1);
    expect(withPages.finalPages![0]!.panelIds).toEqual(['panel-1', 'panel-2']);
    // 引用共享：未触及分支保持相等
    expect(withPages.panels).toBe(project.panels);
    expect(applyComicFinalPages(withPages, []).finalPages).toBeUndefined();
  });

  it('normalizeComicProject 读取 finalPages；坏条目剔除不毁整卡', () => {
    const project = makeProject({ anchor: true });
    const next = normalizeComicProject({
      ...project,
      finalPages: [
        { page: 0, path: 'a.png', imageId: 'i1', panelIds: ['panel-1'], composedAt: '2026-09-02T00:00:00.000Z' },
        { page: 1, path: '', imageId: 'i2', panelIds: ['panel-2'] },
        'garbage',
      ],
    })!;
    expect(next.finalPages).toHaveLength(1);
    expect(next.finalPages![0]!.imageId).toBe('i1');
  });
});

describe('applyStoryToProject', () => {
  it('新分镜接管；已生成图的旧分镜转 stale 副本保留一代', () => {
    const withImage = makeProject({
      anchor: true,
      panels: [
        {
          id: 'old-1', order: 0, scene: '旧开场',
          generationStatus: 'completed',
          imageAsset: { path: 'old.png', imageId: 'oi', taskId: 'ot' },
        } as ComicPanel,
      ],
    });
    const newPanels = [normalizeComicPanel({ id: 'new-1', order: 0, scene: '新开场' })!];
    const { project: next, staleMarked } = applyStoryToProject(withImage, makeStory(), newPanels, []);

    expect(staleMarked).toBe(1);
    expect(next.panels).toHaveLength(2);
    expect(next.panels[0].id).toBe('new-1');
    expect(next.panels[0].stale).toBeFalsy();
    expect(next.panels[1]).toMatchObject({ id: 'old-1', stale: true });
    expect(next.panels[1].imageAsset?.path).toBe('old.png');
    // Anchor 档案保留
    expect(next.consistency?.anchor?.path).toBe('/comic/anchor.png');
  });

  it('再次应用时淘汰上一代 stale 副本（只保留一代历史）', () => {
    const once = applyStoryToProject(
      makeProject({
        panels: [{
          id: 'old-1', order: 0, scene: '旧', generationStatus: 'completed',
          imageAsset: { path: 'old.png', imageId: 'oi', taskId: 'ot' },
        } as ComicPanel],
      }),
      makeStory(),
      [normalizeComicPanel({ id: 'new-1', order: 0, scene: '新' })!],
      [],
    ).project;
    const twice = applyStoryToProject(
      once,
      makeStory(),
      [normalizeComicPanel({ id: 'new-2', order: 0, scene: '更新' })!],
      [],
    );
    expect(twice.staleMarked).toBe(0);
    expect(twice.project.panels.filter((panel) => panel.stale)).toHaveLength(0);
    expect(twice.project.panels.map((panel) => panel.id)).toEqual(['new-2']);
  });

  it('无 Anchor 时 consistency 清空；Story Lock：人工对白按格序保留，种子只补空白', () => {
    const project = makeProject({ anchor: false });
    project.dialogues = [makeDialogue()]; // panel-1（order 0）上的既有对白
    const next = applyStoryToProject(
      project, makeStory(),
      [
        normalizeComicPanel({ id: 'p-1', order: 0, scene: 's' })!,
        normalizeComicPanel({ id: 'p-2', order: 1, scene: 's2' })!,
      ],
      [
        makeDialogue({ id: 'dlg-2', panelId: 'p-1', text: '新种子' }),
        makeDialogue({ id: 'dlg-3', panelId: 'p-2', text: '空白格种子' }),
      ],
    ).project;
    expect(next.consistency).toBeUndefined();
    // 人工对白（panel-1 → 同序新格 p-1）保留；p-1 上的种子被滤掉（AI 只补空白），p-2 种子补入
    expect(next.dialogues.map((item) => item.text)).toEqual(['又是一周！', '空白格种子']);
    expect(next.dialogues[0].panelId).toBe('p-1');
    expect(next.dialogues[1].placementSource).toBe('story_seed');
  });
});

// ---------------------------------------------------------------------------
// 对白纯本地操作（验收 I 的数据层保证）
// ---------------------------------------------------------------------------

describe('dialogue local operations', () => {
  it('upsert 新增 / 更新、remove 删除：只改 dialogues 数组，panels 引用不变', () => {
    const project = makeProject();
    const added = upsertDialogue(project, makeDialogue());
    expect(added.dialogues).toHaveLength(1);
    expect(added.panels).toBe(project.panels);
    expect(added.skillSnapshot).toBe(project.skillSnapshot);

    const updated = upsertDialogue(added, makeDialogue({ text: '改台词' }));
    expect(updated.dialogues).toHaveLength(1);
    expect(updated.dialogues[0].text).toBe('改台词');

    const removed = removeDialogue(updated, 'dlg-1');
    expect(removed.dialogues).toEqual([]);
    expect(dialoguesOfPanel(removed, 'panel-1')).toEqual([]);
    expect(dialoguesOfPanel(updated, 'panel-1')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Anchor 锁定与槽位解析
// ---------------------------------------------------------------------------

describe('lockAnchor / resolveSlotCharacter', () => {
  it('锁定 Anchor 冻结一致性档案（含生成参数兜底）', () => {
    const project = lockAnchor(makeProject({ anchor: false }), {
      panelId: 'panel-1',
      path: '/comic/final.png',
      imageId: 'img-1',
      taskId: 'task-1',
      lockedAt: '2026-08-30T02:00:00.000Z',
    });
    expect(project.consistency?.anchor?.path).toBe('/comic/final.png');
    expect(project.consistency?.generationParams).toEqual({
      size: '1024x1024', quality: 'auto', format: 'png',
    });
    expect(comicPanelSeriesReadiness(project).ready).toBe(true);
  });

  it('按槽位解析角色；未绑定返回 null', () => {
    const project = makeProject();
    expect(resolveSlotCharacter(project, 'hero')?.name).toBe('汤圆');
    expect(resolveSlotCharacter(project, 'reporter')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Character Patch 与状态机（Phase 4）
// ---------------------------------------------------------------------------

describe('applyComicCharacterPatches', () => {
  it('白名单外字段丢弃；数组字段归一；未动字段引用相等', () => {
    const character = makeCharacter();
    const { character: next, applied, ignored } = applyComicCharacterPatches(character, [
      { field: 'appearance', value: '奶油黄短毛圆脸猫，红色贝雷帽' },
      { field: 'immutableTraits', value: ['奶油黄短毛', '圆脸', '红色贝雷帽'] },
      { field: 'id', value: 'evil' },
      { field: 'status', value: 'locked' },
      { field: 'name', value: '' },
    ]);
    expect(applied).toEqual(['appearance', 'immutableTraits']);
    expect(ignored).toEqual(['name']);
    expect(next.id).toBe(character.id);
    expect(next.status).toBe('confirmed');
    expect(next.immutableTraits).toEqual(['奶油黄短毛', '圆脸', '红色贝雷帽']);
    // 未动字段引用相等
    expect(next.description).toBe(character.description);
    expect(next.immutableTraits).not.toBe(character.immutableTraits);
  });

  it('空补丁原样返回', () => {
    const character = makeCharacter();
    const result = applyComicCharacterPatches(character, []);
    expect(result.character).toBe(character);
  });
});

describe('角色状态机与槽位绑定', () => {
  it('draft → confirmed → locked；解锁回 confirmed 保留参考图', () => {
    let character = makeCharacter('draft');
    expect(comicCharacterConfirmationState(makeProject({ character })).ready).toBe(false);
    character = confirmComicCharacter(character);
    expect(character.status).toBe('confirmed');
    character = attachCharacterReference(character, { path: '/refs/tangyuan.png', label: '定妆照' });
    expect(character.referenceImage?.path).toBe('/refs/tangyuan.png');
    character = lockComicCharacter(character);
    expect(character.status).toBe('locked');
    character = unlockComicCharacter(character);
    expect(character.status).toBe('confirmed');
    expect(character.referenceImage?.label).toBe('定妆照');
  });

  it('locked + 参考图 → required 模式门禁通过', () => {
    const locked = lockComicCharacter(
      attachCharacterReference(makeCharacter('locked'), { path: '/refs/t.png', label: 'r' }),
    );
    expect(comicCharacterConfirmationState(makeProject({ character: locked })).ready).toBe(true);
  });

  it('bindSlotCharacter：快照入项目、换演员原位替换；同角色多槽共享一份快照', () => {
    const project = makeProject({ character: null });
    const hero = makeCharacter('confirmed');
    const bound = bindSlotCharacter(project, 'hero', hero);
    expect(bound.characterBindings.hero).toBe(hero.id);
    expect(bound.characterSnapshots).toHaveLength(1);

    // 同一角色绑第二个槽位：快照不重复
    const twice = bindSlotCharacter(bound, 'reporter', hero);
    expect(twice.characterSnapshots).toHaveLength(1);
    expect(twice.characterBindings.reporter).toBe(hero.id);

    // 换演员：绑定指向新 id，旧快照保留（溯源）
    const replacement = normalizeComicCharacter({ id: 'char-2', name: '新演员' })!;
    const swapped = bindSlotCharacter(twice, 'hero', replacement);
    expect(swapped.characterBindings.hero).toBe('char-2');
    expect(swapped.characterSnapshots.map(item => item.id)).toContain('char-1');
    expect(swapped.characterSnapshots).toHaveLength(2);
  });

  it('unbindSlot：解绑但快照保留；upsertCharacterSnapshot 更新既有快照', () => {
    const project = makeProject();
    const unbound = unbindSlot(project, 'hero');
    expect(unbound.characterBindings.hero).toBeUndefined();
    expect(unbound.characterSnapshots).toHaveLength(1);

    const confirmed = confirmComicCharacter(makeCharacter('draft'));
    const updated = upsertCharacterSnapshot(unbound, confirmed);
    expect(updated.characterSnapshots[0]!.status).toBe('confirmed');
  });
});
