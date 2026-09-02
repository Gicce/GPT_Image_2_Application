/**
 * 漫画分镜修复层（Phase 6）——LLM 输出 / 旧持久化 → 可用分镜面。
 *
 * 职责（全部纯函数）：
 *  - repairStoryboard：panelCount 契约（多余截断、不足则回写 story.panelCount）、
 *    order 连续重排、未知角色剔除、孤儿对白剔除；返回 repairs 报告（UI 可提示
 *    「已自动修复 N 处」，绝不静默吞）；
 *  - storyboard 绝不携带图片（panels 只描述画面；生成结果由任务终态回写）。
 */

import { normalizeComicDialogue, normalizeComicPanel, normalizeComicStory } from './normalize';
import type { ComicCharacter, ComicDialogue, ComicPanel, ComicStory } from './types';

export interface StoryboardRepairReport {
  /** 应用到项目前的修复动作清单（人类可读，供 UI 呈现）。 */
  repairs: string[];
  /** 修复后仍无法挽救（分镜全空）→ true，调用方应中止应用。 */
  fatal: boolean;
}

export interface RepairedStoryboard {
  story: ComicStory;
  panels: ComicPanel[];
  dialogues: ComicDialogue[];
  report: StoryboardRepairReport;
}

/**
 * 修复分镜面：
 *  1. panels 按 order 稳定排序并重编号 0..n-1（id 同步改为 panel-{order}，
 *     对白 panelId 跟随映射——LLM id 漂移 / 旧文档都能救回）；
 *  2. 剔除 panels.characterIds 中项目里不存在的角色（防 prompt 编译时悬空引用）；
 *  3. 剔除 panelId 无法映射的对白；
 *  4. panelCount 契约：panels 多于 story.panelCount → 截断；少于 → 回写 story.panelCount
 *     （接受现实格数，beats 不足部分由 UI 提示补齐，不虚构分镜）。
 */
export function repairStoryboard(
  story: ComicStory,
  rawPanels: unknown,
  rawDialogues: unknown,
  characters: ComicCharacter[],
): RepairedStoryboard {
  const repairs: string[] = [];
  const normalizedStory = normalizeComicStory(story) ?? {
    title: '本期漫画', topic: '', summary: '', characterIds: [],
    beats: [], endingType: 'twist' as const, panelCount: 1,
  };

  const knownCharacterIds = new Set(characters.map(character => character.id));
  const panels = (Array.isArray(rawPanels) ? rawPanels : [])
    .map(normalizeComicPanel)
    .filter((panel): panel is ComicPanel => panel !== null);

  if (!panels.length) {
    return {
      story: normalizedStory,
      panels: [],
      dialogues: [],
      report: { repairs: ['分镜为空，无法应用'], fatal: true },
    };
  }

  panels.sort((a, b) => a.order - b.order);

  const idMap = new Map<string, string>();
  const renamed: string[] = [];
  panels.forEach((panel, index) => {
    const canonical = `panel-${index}`;
    if (panel.id !== canonical) {
      idMap.set(panel.id, canonical);
      renamed.push(panel.id);
      panel.id = canonical;
    }
    if (panel.order !== index) panel.order = index;
  });
  if (renamed.length) {
    repairs.push(`${renamed.length} 个分镜 id/order 已重排对齐`);
  }

  for (const panel of panels) {
    const before = panel.characterIds.length;
    panel.characterIds = panel.characterIds.filter(id => knownCharacterIds.has(id));
    if (panel.characterIds.length !== before) {
      repairs.push(`分镜 ${panel.order + 1} 剔除了 ${before - panel.characterIds.length} 个未知角色`);
    }
  }

  let dialogues = (Array.isArray(rawDialogues) ? rawDialogues : [])
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const rawId = typeof record.panelId === 'string' ? record.panelId.trim() : '';
      record.panelId = idMap.get(rawId) ?? rawId;
      return normalizeComicDialogue(record);
    })
    .filter((dialogue): dialogue is ComicDialogue => dialogue !== null)
    .filter(dialogue => panels.some(panel => panel.id === dialogue.panelId));
  const droppedDialogues = (Array.isArray(rawDialogues) ? rawDialogues.length : 0) - dialogues.length;
  if (droppedDialogues > 0) {
    repairs.push(`剔除了 ${droppedDialogues} 条无法对应分镜的对白`);
  }

  if (panels.length > normalizedStory.panelCount) {
    const dropped = panels.splice(normalizedStory.panelCount).length;
    repairs.push(`分镜数超出格数约定，截断了 ${dropped} 格`);
    const keptIds = new Set(panels.map(panel => panel.id));
    const prunedDialogues = dialogues.filter(dialogue => keptIds.has(dialogue.panelId));
    if (prunedDialogues.length !== dialogues.length) {
      repairs.push(`随截断分镜剔除 ${dialogues.length - prunedDialogues.length} 条对白`);
      dialogues = prunedDialogues;
    }
  } else if (panels.length < normalizedStory.panelCount) {
    normalizedStory.panelCount = panels.length;
    repairs.push(`实际分镜少于格数约定，格数已回写为 ${panels.length}`);
  }

  return { story: normalizedStory, panels, dialogues, report: { repairs, fatal: false } };
}
