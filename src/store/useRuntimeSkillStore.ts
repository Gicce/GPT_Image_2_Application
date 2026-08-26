/**
 * Runtime Skill Settings（V4.2）—— 技能中心开关的唯一载体。
 *
 * 只有 canDisable 的技能允许停用（region_replacement / replication_boost）；
 * 核心技能（编译 / 校验 / 合同类）写入 disabledSkillIds 也无效
 * （effectiveRuntimeSkills 归一化时忽略）。停用 = 真实效果：
 *  - region_replacement → 区域合同不编译进最终 Prompt；
 *  - replication_boost → 优化指令不含复刻增强条款。
 * 轻量 localStorage 持久化（runtime_skills_v1；与工作区快照同一手动模式）。
 */

import { create } from 'zustand';
import { effectiveRuntimeSkills } from '../features/vision/skills/registry';

const STORAGE_KEY = 'runtime_skills_v1';

function loadDisabled(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { disabledSkillIds?: unknown };
    return Array.isArray(parsed.disabledSkillIds)
      ? parsed.disabledSkillIds.filter((id): id is string => typeof id === 'string')
      : [];
  } catch {
    return [];
  }
}

function persistDisabled(disabledSkillIds: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ disabledSkillIds }));
  } catch { /* localStorage 不可用不阻断（内存态仍生效） */ }
}

export interface RuntimeSkillState {
  disabledSkillIds: string[];
  /** 切换技能启用态（核心技能调用无效，返回后状态不变）。 */
  toggleSkill: (skillId: string, disabled: boolean) => void;
  isSkillDisabled: (skillId: string) => boolean;
}

export const useRuntimeSkillStore = create<RuntimeSkillState>((set, get) => ({
  disabledSkillIds: loadDisabled(),
  toggleSkill: (skillId, disabled) => {
    const before = get().disabledSkillIds;
    // 核心技能保护：effectiveRuntimeSkills 过滤后仍在 = 不可停用
    const stillEnabled = effectiveRuntimeSkills(disabled ? [...before, skillId] : before)
      .some(skill => skill.id === skillId);
    if (disabled && stillEnabled) return;
    const next = disabled
      ? [...new Set([...before, skillId])]
      : before.filter(id => id !== skillId);
    persistDisabled(next);
    set({ disabledSkillIds: next });
  },
  isSkillDisabled: skillId => get().disabledSkillIds.includes(skillId),
}));
