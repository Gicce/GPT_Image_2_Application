/**
 * Model Routing Policy（V4.1）—— AI 模型路由的用户配置持久层。
 *
 * 只存「用户显式改过的条目」：缺省条目 = 推荐配置（follow 链），
 * rehydrate 时缺失条目一律按推荐值解析，旧用户升级零迁移、绝不 undefined。
 *
 * 本 store 只描述路由意图；「解析出具体模型」一律走 resolveModelForRole（唯一入口）。
 * UI-only 铁律：本 store 的任何读写都不得触碰视觉工作区 semantic state。
 */

import { create } from 'zustand';
import type { AiModelRole } from './modelRoles';
import { getAiRoleDefinition } from './modelRoles';

export interface AiRoleRoutingEntry {
  mode: 'follow' | 'manual';
  /** follow 模式的目标 role（缺省 = 该 role 的推荐 defaultFollow）。 */
  followedRole?: AiModelRole;
  /** manual 模式显式指定的模型。 */
  profileId?: string;
  modelId?: string;
}

export type AiRoutingConfigMap = Partial<Record<AiModelRole, AiRoleRoutingEntry>>;

/** 进程内「最近使用」记录（不持久化；设置页轻量展示用，禁止新建数据库）。 */
export interface AiRoleUsageRecord {
  role: AiModelRole;
  modelId: string;
  displayName: string;
  providerName: string;
  at: string;
}

interface AiModelRoutingState {
  config: AiRoutingConfigMap;
  hydrated: boolean;
  lastUsed: Partial<Record<AiModelRole, AiRoleUsageRecord>>;

  hydrate: () => void;
  persist: () => void;
  setEntry: (role: AiModelRole, entry: AiRoleRoutingEntry) => void;
  /** 恢复该 role 的推荐配置（删除用户覆盖条目）。 */
  resetRole: (role: AiModelRole) => void;
  resetAll: () => void;
  getEffectiveEntry: (role: AiModelRole) => AiRoleRoutingEntry;
  recordUsage: (record: AiRoleUsageRecord) => void;
}

const ROUTING_STORAGE_KEY = 'ai_model_routing_v1';

function readPersistedConfig(): AiRoutingConfigMap {
  try {
    const raw = localStorage.getItem(ROUTING_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as AiRoutingConfigMap;
  } catch {
    return {};
  }
}

/** role 的推荐（缺省）路由条目：跟随链来自 modelRoles 的 defaultFollow。 */
export function recommendedEntry(role: AiModelRole): AiRoleRoutingEntry {
  const def = getAiRoleDefinition(role);
  if (def.configurable !== 'routing' || !def.defaultFollow) {
    return { mode: 'follow' };
  }
  return { mode: 'follow', followedRole: def.defaultFollow };
}

export const useAiModelRoutingStore = create<AiModelRoutingState>((set, get) => ({
  config: {},
  hydrated: false,
  lastUsed: {},

  hydrate: () => {
    if (get().hydrated) return;
    set({ config: readPersistedConfig(), hydrated: true });
  },

  persist: () => {
    try {
      localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(get().config));
    } catch {
      // localStorage 不可用时不阻塞运行（与 aiProviders store 同语义）
    }
  },

  setEntry: (role, entry) => {
    set(state => ({ config: { ...state.config, [role]: entry } }));
    get().persist();
  },

  resetRole: role => {
    set(state => {
      const next = { ...state.config };
      delete next[role];
      return { config: next };
    });
    get().persist();
  },

  resetAll: () => {
    set({ config: {} });
    get().persist();
  },

  /** 用户条目缺失 / 非法时回落推荐条目（rehydrate 安全）。 */
  getEffectiveEntry: role => {
    const entry = get().config[role];
    if (!entry || typeof entry !== 'object') return recommendedEntry(role);
    if (entry.mode === 'manual') {
      return entry.profileId && entry.modelId ? entry : recommendedEntry(role);
    }
    return { mode: 'follow', followedRole: entry.followedRole || recommendedEntry(role).followedRole };
  },

  recordUsage: record => {
    set(state => ({ lastUsed: { ...state.lastUsed, [record.role]: record } }));
  },
}));

/** 测试 / 复位辅助：恢复模块级 store 初态。 */
export function __resetAiModelRoutingStoreForTests(): void {
  useAiModelRoutingStore.setState({ config: {}, hydrated: false, lastUsed: {} });
}
