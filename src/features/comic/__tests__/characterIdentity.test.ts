/**
 * V4.2.11 §A · 角色身份键与卡司去重（§111 五案）。
 * 根因背景：docs/ai-comic/19 审计 Q1——V4.2.10 用槽位名全等判定「概念角色是否已存在」，
 * 「小圆鸭（主角）」≠「小圆鸭」→ 追加 concept-N 复制槽。
 */
import { describe, expect, it } from 'vitest';
import {
  characterIdentitiesMatch,
  characterNameBase,
  dedupeComicProjectCast,
  stripCharacterNameSuffix,
} from '../characterIdentity';
import { normalizeComicProject } from '../normalize';
import type { ComicCharacter, ComicProject, ComicSkill } from '../types';

const slot = (slotId: string, name: string, required = false, characterKey?: string) => ({
  slotId, name, required, characterKey,
});

const snapshot = (id: string, name: string): ComicCharacter => ({
  id,
  slotName: name,
  name,
  role: '角色',
  description: '',
  status: 'locked',
  origin: 'ai',
  immutableTraits: [],
  mutableTraits: [],
  appearance: '',
  createdAt: 0,
  updatedAt: 0,
}) as unknown as ComicCharacter;

const skillOf = (slots: ComicSkill['characterSlots']): ComicSkill => ({
  id: 'skill-1', name: '鸭梨山大', characterSlots: slots,
} as unknown as ComicSkill);

const projectOf = (skill: ComicSkill, snapshots: ComicCharacter[], bindings: Record<string, string>): ComicProject => ({
  id: 'project-1', name: '鸭梨山大 · 第一期', stage: 'story_ready',
  skillSnapshot: skill, characterSnapshots: snapshots, characterBindings: bindings,
  panels: [], dialogues: [],
} as unknown as ComicProject);

describe('stripCharacterNameSuffix / characterNameBase', () => {
  it('剥尾部身份后缀（全角/半角/多层）', () => {
    expect(stripCharacterNameSuffix('小圆鸭（主角）')).toBe('小圆鸭');
    expect(stripCharacterNameSuffix('小圆鸭(主角)')).toBe('小圆鸭');
    expect(stripCharacterNameSuffix('鸭妈妈（长辈）（唠叨）')).toBe('鸭妈妈');
    expect(stripCharacterNameSuffix('小圆鸭')).toBe('小圆鸭');
  });

  it('基名归一：全半角 / 空白 / 拉丁大小写折叠', () => {
    expect(characterNameBase('Ｄｕｃｋ Ｍｏｍ')).toBe('duckmom');
    expect(characterNameBase(' 小圆鸭 ')).toBe('小圆鸭');
  });
});

describe('§111-1 同键不同后缀命名归一为同一角色', () => {
  it('characterIdentitiesMatch：小圆鸭（主角） ↔ 小圆鸭', () => {
    expect(characterIdentitiesMatch(slot('duckling', '小圆鸭（主角）', true), { name: '小圆鸭' })).toBe(true);
    expect(characterIdentitiesMatch(slot('duckMom', '鸭妈妈（长辈）'), { name: '鸭 妈妈' })).toBe(true);
  });
});

describe('§111-2 绝不字符串相似合并：鸭妈妈 ≠ 鸭老师', () => {
  it('不同角色名（即使同前缀「鸭」）不匹配', () => {
    expect(characterIdentitiesMatch({ name: '鸭妈妈' }, { name: '鸭老师' })).toBe(false);
    expect(characterIdentitiesMatch({ name: '小圆鸭' }, { name: '小圆熊' })).toBe(false);
  });

  it('两个不同后缀的同基名（路人（甲）/ 路人（乙））互不合并——后缀也是身份', () => {
    expect(characterIdentitiesMatch({ name: '路人（甲）' }, { name: '路人（乙）' })).toBe(false);
  });
});

describe('§111-3 显式 characterKey 跨命名形态合并', () => {
  it('键相等即同一身份；键不同不合并', () => {
    expect(characterIdentitiesMatch({ characterKey: 'duck_mom', name: 'Mom Duck' }, { characterKey: 'duck_mom', name: '鸭妈妈' })).toBe(true);
    expect(characterIdentitiesMatch({ characterKey: 'main_duck', name: '小圆鸭' }, { characterKey: 'duck_mom', name: '小圆鸭' })).toBe(false);
  });

  it('显式键吸收同基名 keyless 槽位（V4.2.10 兼容路径）', () => {
    const project = projectOf(
      skillOf([slot('duckMom', '鸭妈妈', false, 'duck_mom'), slot('concept-5', '鸭妈妈（长辈）')]),
      [snapshot('s1', '鸭妈妈')],
      { duckMom: 's1' },
    );
    const result = dedupeComicProjectCast(project);
    expect(result.skillSnapshot.characterSlots.map(item => item.slotId)).toEqual(['duckMom']);
  });
});

describe('§111-4 真实《鸭梨山大》重复卡司归并（6 槽 → 3 槽）', () => {
  const realSkill = skillOf([
    slot('duckling', '小圆鸭（主角）', true),
    slot('duckMom', '鸭妈妈（长辈）'),
    slot('duckTeacher', '鸭老师（配角）'),
    slot('concept-4', '小圆鸭'),
    slot('concept-5', '鸭妈妈'),
    slot('concept-6', '鸭老师'),
  ]);
  const realSnapshots = [
    snapshot('b26c3f86', '小圆鸭'),
    snapshot('5efcb13f', '鸭妈妈'),
    snapshot('0bc7b699', '鸭妈妈'),
    snapshot('0009259d', '鸭老师'),
    snapshot('190b2b42', '小圆鸭'),
    snapshot('c6f7e878', '鸭老师'),
  ];
  const realBindings: Record<string, string> = {
    duckling: 'b26c3f86', duckMom: '5efcb13f', duckTeacher: '0009259d',
    'concept-4': 'b26c3f86', 'concept-5': '0bc7b699', 'concept-6': '0009259d',
  };

  it('归并后 = 3 槽（必选小圆鸭 + 可选鸭妈妈/鸭老师），无重复快照', () => {
    const result = dedupeComicProjectCast(projectOf(realSkill, realSnapshots, realBindings));
    const slots = result.skillSnapshot.characterSlots;
    expect(slots).toHaveLength(3);
    expect(slots.find(item => item.slotId === 'duckling')?.required).toBe(true);
    expect(slots.some(item => item.slotId.startsWith('concept-'))).toBe(false);
    expect(result.characterSnapshots.map(item => item.id).sort()).toEqual(['0009259d', '5efcb13f', 'b26c3f86']);
    expect(result.characterBindings).toEqual({
      duckling: 'b26c3f86', duckMom: '5efcb13f', duckTeacher: '0009259d',
    });
  });

  it('引用重映射：story/panel/dialogue 中的被并快照 id 指向保留快照', () => {
    const project = projectOf(realSkill, realSnapshots, realBindings);
    project.story = {
      title: '小鸭变鸭梨', summary: '', panelCount: 4, endingType: 'punchline',
      beats: [], characterIds: ['190b2b42', 'b26c3f86'],
    } as unknown as ComicProject['story'];
    project.panels = [{
      id: 'panel-0', order: 0, scene: '', characterIds: ['c6f7e878'],
      characterActions: [], characterExpressions: [], shotType: '', camera: '', composition: '',
      props: [], background: '', environmentText: '', generationStatus: 'queued',
    } as unknown as ComicProject['panels'][number]];
    project.dialogues = [{ id: 'd1', panelId: 'panel-0', speakerId: '0bc7b699', type: 'speech', text: '…', position: { x: 0.5, y: 0.5 } } as unknown as ComicProject['dialogues'][number]];

    const result = dedupeComicProjectCast(project);
    expect(result.story?.characterIds).toEqual(['b26c3f86', 'b26c3f86']);
    expect(result.panels[0]?.characterIds).toEqual(['0009259d']);
    expect(result.dialogues[0]?.speakerId).toBe('5efcb13f');
  });

  it('幂等：归并结果再归并为 no-op', () => {
    const once = dedupeComicProjectCast(projectOf(realSkill, realSnapshots, realBindings));
    const twice = dedupeComicProjectCast(once);
    expect(twice).toEqual(once);
  });

  it('normalizeComicProject 打开项目即触发归并（持久化自愈入口）', () => {
    const normalized = normalizeComicProject({
      skillSnapshot: realSkill,
      characterSnapshots: realSnapshots,
      characterBindings: realBindings,
    });
    expect(normalized?.skillSnapshot.characterSlots).toHaveLength(3);
    expect(normalized?.characterSnapshots).toHaveLength(3);
  });
});

describe('§111-5 分镜/故事引用 characterId 不重建槽位', () => {
  it('已有键化槽位时，mergeConceptCharacterSlots 语义不追加复制槽（经 dedupe 幂等保证）', () => {
    // planner 侧 mergeConceptCharacterSlots 由 comicPlanner 测试覆盖；
    // 此处验证项目层：概念净名槽位与带后缀槽位同存时归一，不因再次 normalize 重建。
    const project = projectOf(
      skillOf([slot('duckling', '小圆鸭', true)]),
      [snapshot('b26c3f86', '小圆鸭')],
      { duckling: 'b26c3f86' },
    );
    const again = normalizeComicProject(JSON.parse(JSON.stringify(project)) as unknown);
    expect(again?.skillSnapshot.characterSlots).toHaveLength(1);
    expect(again?.skillSnapshot.characterSlots[0]?.slotId).toBe('duckling');
  });
});
