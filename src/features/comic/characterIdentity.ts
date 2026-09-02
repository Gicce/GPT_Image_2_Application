/**
 * 角色身份键（V4.2.11 §A）——槽位 / 概念角色 / 项目快照共用的稳定身份判定。
 *
 * 背景（docs/ai-comic/19 审计 Q1）：V4.2.10 的重复角色根因是「字符串全等」判定——
 * 起草槽位名带身份后缀（小圆鸭（主角）），概念角色名是净名（小圆鸭），全等失败
 * → 追加 concept-N 复制槽。本模块给出身份语义：
 *
 * 铁律：
 *  - 键相等才归一；绝不因字符串相似合并（鸭妈妈 ≠ 鸭老师）。
 *  - 净名（bare）槽位吸收同基名的带后缀槽位（V4.2.10 故障形态）；
 *    但两个**不同后缀**的槽位（路人（甲）/ 路人（乙））互不合并——后缀也是身份。
 *  - 显式 characterKey（planner 下发，如 main_duck）最优先；与净名吸收规则叠加。
 */

import type { ComicProject } from './types';

/** 携带身份的命名实体（槽位 / 概念角色 / 演员库条目同构）。 */
export interface ComicCharacterKeyCarrier {
  characterKey?: string;
  name: string;
}

/** 全角 ASCII → 半角、去空白、拉丁小写：用于键归一（不动中文字符；名字空白不承载身份）。 */
function normalizeKeyText(value: string): string {
  return value
    .replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

/** 剥尾部身份后缀（（主角）/ (长辈)…，可连续多层）：小圆鸭（主角）→ 小圆鸭。 */
export function stripCharacterNameSuffix(name: string): string {
  let current = name.replace(/\s+/g, ' ').trim();
  // 尾部括号组整体剥离：仅当括号内不含括号且括号后无其他内容
  for (;;) {
    const match = current.match(/[（(]([^（()）]*)[)）]\s*$/);
    if (!match || match.index === undefined) return current;
    current = current.slice(0, match.index).trim();
  }
}

/** 名字的基名键（剥后缀 + 归一）：小圆鸭（主角） 与 小圆鸭 同为 `小圆鸭`。 */
export function characterNameBase(name: string): string {
  return normalizeKeyText(stripCharacterNameSuffix(name));
}

/** 完整名键（含后缀归一）：路人（甲）≠ 路人（乙）。 */
function characterNameFull(name: string): string {
  return normalizeKeyText(name);
}

/** 是否净名（不带身份后缀）。 */
export function isBareCharacterName(name: string): boolean {
  return characterNameFull(name) === characterNameBase(name);
}

/**
 * 身份等价判定（非传递关系，配合 groupCharacterKeyed 使用）：
 *  - 显式 characterKey 相等 ⇒ 同一身份；
 *  - 双方净名且基名相等 ⇒ 同一身份；
 *  - 一方净名、一方带后缀且基名相等 ⇒ 同一身份（V4.2.10 重复根因形态）；
 *  - 双方带后缀 ⇒ 必须完整名相等（后缀即身份：路人（甲）≠ 路人（乙））。
 */
export function characterIdentitiesMatch(a: ComicCharacterKeyCarrier, b: ComicCharacterKeyCarrier): boolean {
  if (a.characterKey && b.characterKey) return normalizeKeyText(a.characterKey) === normalizeKeyText(b.characterKey);
  const baseEq = characterNameBase(a.name) === characterNameBase(b.name);
  if (!baseEq) return false;
  const aBare = isBareCharacterName(a.name);
  const bBare = isBareCharacterName(b.name);
  if (aBare && bBare) return true;
  if (aBare !== bBare) return true;
  // 双方同基名且都带后缀：完整名相等才同一（后缀区分身份）
  return characterNameFull(a.name) === characterNameFull(b.name);
}

/** 分组键：同组内 items 两两 identity match（歧义守卫见 groupCharacterKeyed）。 */
function groupKeyOf(item: ComicCharacterKeyCarrier): string {
  if (item.characterKey) return `key:${normalizeKeyText(item.characterKey)}`;
  const base = characterNameBase(item.name);
  return isBareCharacterName(item.name) ? `bare:${base}` : `suff:${base}|${characterNameFull(item.name)}`;
}

/**
 * 身份分组（union-find + 歧义守卫）：
 *  - 显式键组内合并；净名组吸收**唯一**同基名的带后缀组；
 *  - 同基名存在 ≥2 个不同后缀组时，净名不吸收（后缀在区分身份，歧义保留）。
 * 返回 item → 组代表键 的映射；每组内至少 1 项，孤立项自成一组的键。
 */
export function groupCharacterKeyed<T extends ComicCharacterKeyCarrier>(items: readonly T[]): Map<T, string> {
  const assignment = new Map<T, string>();
  const byKey = new Map<string, T[]>();
  for (const item of items) {
    const key = groupKeyOf(item);
    assignment.set(item, key);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(item);
    else byKey.set(key, [item]);
  }
  // 净名吸收：bare:B 唯一同基名带后缀组 suff:B|X 时并组
  for (const [bareKey, bareItems] of byKey) {
    if (!bareKey.startsWith('bare:')) continue;
    const base = bareKey.slice('bare:'.length);
    const suffKeys = [...byKey.keys()].filter(key => key.startsWith(`suff:${base}|`) && key !== bareKey);
    if (suffKeys.length !== 1) continue;
    const target = suffKeys[0]!;
    for (const item of bareItems) assignment.set(item, target);
  }
  // 显式键吸收：key:K 组也吸收与该组任一成员名字身份相等的 keyless 项
  for (const [explicitKey, keyedItems] of byKey) {
    if (!explicitKey.startsWith('key:')) continue;
    for (const [otherKey, otherItems] of byKey) {
      if (otherKey === explicitKey || otherKey.startsWith('key:')) continue;
      if (!keyedItems.some(anchor => otherItems.some(item => characterIdentitiesMatch(anchor, item)))) continue;
      for (const item of otherItems) assignment.set(item, explicitKey);
    }
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// 打开项目时的卡司归并（幂等自愈迁移）
// ---------------------------------------------------------------------------

/** 组内保位优先级：必选 > 有绑定 > 先出现。 */
interface SlotLike {
  slotId: string;
  name: string;
  required: boolean;
  displayRule?: string;
  characterKey?: string;
  defaultCharacterId?: string;
}

function keepSlotOf<T extends SlotLike>(group: readonly T[], hasBinding: (slot: T) => boolean): T {
  return group.find(slot => slot.required)
    ?? group.find(slot => hasBinding(slot))
    ?? group[0]!;
}

/**
 * 卡司归并（V4.2.11 §A / §111）：打开项目时对重复身份的槽位做一次性归并迁移。
 *  - 同身份槽位组保一个（必选/有绑定优先），required/displayRule 组内合并；
 *  - 被并槽位的绑定迁移到保位槽（保位已有绑定时，被并绑定指向的快照转重复待清）；
 *  - 与保留快照同身份的多余快照（重复绑定 / 未绑定孤儿）：引用（story/panels/dialogues）
 *    全部重映射到保留快照后从卡司移除；其已生成的图片/任务历史不受影响（账单可追溯）。
 * 幂等：归并后同身份仅剩一项，再跑为 no-op。绝不删除不同身份的任何快照。
 */
export function dedupeComicProjectCast(project: ComicProject): ComicProject {
  const slots = project.skillSnapshot.characterSlots;
  if (slots.length === 0) return project;

  const groups = new Map<string, typeof slots>();
  const assignment = groupCharacterKeyed(slots);
  let duplicated = false;
  for (const slot of slots) {
    const key = assignment.get(slot)!;
    const bucket = groups.get(key);
    if (bucket) { bucket.push(slot); duplicated = true; }
    else groups.set(key, [slot]);
  }
  if (!duplicated) return project;

  const hasBinding = (slot: SlotLike) => Boolean(project.characterBindings[slot.slotId]);
  const keptSlots: typeof slots = [];
  const droppedSlotIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length === 1) { keptSlots.push(group[0]!); continue; }
    const keeper = keepSlotOf(group, hasBinding);
    const others = group.filter(slot => slot.slotId !== keeper.slotId);
    keptSlots.push({
      ...keeper,
      required: group.some(slot => slot.required),
      displayRule: keeper.displayRule ?? others.find(slot => slot.displayRule)?.displayRule,
      characterKey: keeper.characterKey ?? assignment.get(keeper),
    });
    for (const other of others) droppedSlotIds.add(other.slotId);
  }

  // 绑定迁移：保位缺绑定时继承被并槽位的绑定
  const bindings: Record<string, string> = {};
  const droppedBoundSnapshotIds = new Set<string>();
  const keptSlotIds = new Set(keptSlots.map(slot => slot.slotId));
  for (const [slotId, characterId] of Object.entries(project.characterBindings)) {
    if (keptSlotIds.has(slotId)) { bindings[slotId] = characterId; continue; }
    if (droppedSlotIds.has(slotId)) droppedBoundSnapshotIds.add(characterId);
  }
  for (const slot of keptSlots) {
    if (bindings[slot.slotId]) continue;
    const inherited = slots.find(
      source => source.slotId !== slot.slotId
        && droppedSlotIds.has(source.slotId)
        && project.characterBindings[source.slotId],
    );
    if (inherited) bindings[slot.slotId] = project.characterBindings[inherited.slotId]!;
  }

  // 快照归并：保留绑定快照；同身份多余快照重映射引用后移除
  const keptSnapshotIds = new Set(Object.values(bindings));
  const removals = new Map<string, string>(); // 被移除快照 id → 保留快照 id
  for (const snapshot of droppedBoundSnapshotIds) {
    if (keptSnapshotIds.has(snapshot)) continue;
    const target = resolveDuplicateSnapshotTarget(project, snapshot);
    if (target) removals.set(snapshot, target);
  }
  // 未绑定的重复孤儿（与任一保留快照同身份）
  for (const character of project.characterSnapshots) {
    if (keptSnapshotIds.has(character.id) || removals.has(character.id)) continue;
    if (droppedBoundSnapshotIds.has(character.id)) continue;
    const target = resolveDuplicateSnapshotTarget(project, character.id);
    if (target) removals.set(character.id, target);
  }

  const remapId = (id: string) => removals.get(id) ?? id;
  const snapshots = project.characterSnapshots.filter(character => !removals.has(character.id));
  const story = project.story ? {
    ...project.story,
    characterIds: project.story.characterIds.map(remapId),
  } : project.story;
  const panels = project.panels.map(panel => ({
    ...panel,
    characterIds: panel.characterIds.map(remapId),
  }));
  const dialogues = project.dialogues.map(dialogue => ({
    ...dialogue,
    speakerId: dialogue.speakerId === 'narrator' ? dialogue.speakerId : remapId(dialogue.speakerId),
  }));

  return {
    ...project,
    skillSnapshot: { ...project.skillSnapshot, characterSlots: keptSlots },
    characterBindings: bindings,
    characterSnapshots: snapshots,
    story,
    panels,
    dialogues,
  };
}

/** 被移除快照的保留目标：卡司内与其同身份的快照（绑定者优先）；无则不移除。 */
function resolveDuplicateSnapshotTarget(project: ComicProject, duplicateId: string): string | null {
  const duplicate = project.characterSnapshots.find(character => character.id === duplicateId);
  if (!duplicate) return null;
  const boundIds = new Set(Object.values(project.characterBindings));
  const candidates = project.characterSnapshots.filter(character =>
    character.id !== duplicateId && characterIdentitiesMatch(character, duplicate));
  if (candidates.length === 0) return null;
  return (candidates.find(character => boundIds.has(character.id)) ?? candidates[0])!.id;
}
