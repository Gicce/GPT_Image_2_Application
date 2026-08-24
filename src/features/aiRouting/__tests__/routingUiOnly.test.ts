/**
 * UI-only 铁律测试（V4.1）：「AI 模型使用」设置页的路由配置读写
 * 绝不触碰视觉工作区 semantic state（semanticRevision / recreation）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

type StoreApi = (typeof import('../modelRoutingPolicy'))['useAiModelRoutingStore'];
type WorkspaceApi = (typeof import('../../../store/useVisionWorkspaceStore'))['useVisionWorkspaceStore'];

const ROUTING_PATH = fileURLToPath(new URL('../modelRoutingPolicy.ts', import.meta.url));
const WORKSPACE_PATH = fileURLToPath(new URL('../../../store/useVisionWorkspaceStore.ts', import.meta.url));

function installLocalStorageStub() {
  const memory = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => { memory.set(key, String(value)); },
    removeItem: (key: string) => { memory.delete(key); },
    clear: () => memory.clear(),
  });
  return memory;
}

describe('UI-only：路由配置不弄脏视觉工作区语义状态', () => {
  let routing: StoreApi;
  let workspace: WorkspaceApi;

  beforeEach(async () => {
    vi.resetModules();
    installLocalStorageStub();
    routing = (await import('../modelRoutingPolicy')).useAiModelRoutingStore;
    workspace = (await import('../../../store/useVisionWorkspaceStore')).useVisionWorkspaceStore;
    routing.setState({ config: {}, hydrated: true, lastUsed: {} });
  });

  it('设置 follow → manual / 展开 ModelPicker / 重置：semanticRevision 与 recreation 不变', () => {
    workspace.setState({
      promptDraft: '最终 Prompt',
      recreation: {
        plan: { summary: '方案', fields: [] },
        originalPrompt: '原始',
        originalNegativePrompt: '',
        editState: 'optimized',
        semanticRevision: 7,
        optimizedRevision: 7,
        adjustInstruction: '指令',
        optimizedPrompt: '最终 Prompt',
      } as never,
    });
    const before = JSON.stringify({
      recreation: workspace.getState().recreation,
      promptDraft: workspace.getState().promptDraft,
    });

    // 模拟设置页操作序列：manual → 换模型 → 重置
    routing.getState().setEntry('vision_prompt_optimizer', { mode: 'manual', profileId: 'p', modelId: 'm' });
    routing.getState().setEntry('vision_prompt_optimizer', { mode: 'manual', profileId: 'p2', modelId: 'm2' });
    routing.getState().resetRole('vision_prompt_optimizer');
    routing.getState().resetAll();

    const after = JSON.stringify({
      recreation: workspace.getState().recreation,
      promptDraft: workspace.getState().promptDraft,
    });
    expect(after).toBe(before);
    const recreation = workspace.getState().recreation as unknown as { semanticRevision: number; optimizedRevision: number } | null;
    expect(recreation?.semanticRevision).toBe(7);
    expect(recreation?.optimizedRevision).toBe(7);
    expect(ROUTING_PATH).toContain('modelRoutingPolicy');
    expect(WORKSPACE_PATH).toContain('useVisionWorkspaceStore');
  });
});
