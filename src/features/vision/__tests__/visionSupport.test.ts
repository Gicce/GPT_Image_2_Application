import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { listVisionSessions, saveVisionSession, deleteVisionSession, similarityToSnapshot, type VisionSession } from '../session';
import type { SimilarityReport } from '../similarity';

// vitest 默认 node 环境无 localStorage —— session.ts 依赖它，这里注入内存版 stub
beforeAll(() => {
  const store = new Map<string, string>();
  const stub = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
});

function makeSession(id: string, extra: Partial<VisionSession> = {}): VisionSession {
  return {
    id,
    sourcePath: `D:/imgs/${id}.png`,
    visionProfileId: 'p1',
    visionModelId: 'gpt-4o',
    mode: 'reverse_prompt',
    iterations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

describe('VisionSession 历史记录', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('保存后可读取，且新的在前', () => {
    saveVisionSession(makeSession('s1'));
    saveVisionSession(makeSession('s2'));
    const sessions = listVisionSessions();
    expect(sessions.map(s => s.id)).toEqual(['s2', 's1']);
  });

  it('同 id 保存为更新（不产生重复）', () => {
    saveVisionSession(makeSession('s1'));
    saveVisionSession(makeSession('s1', { mode: 'high_fidelity' }));
    const sessions = listVisionSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].mode).toBe('high_fidelity');
  });

  it('删除指定会话', () => {
    saveVisionSession(makeSession('s1'));
    saveVisionSession(makeSession('s2'));
    deleteVisionSession('s1');
    expect(listVisionSessions().map(s => s.id)).toEqual(['s2']);
  });

  it('历史上限 50 条（超出淘汰最旧）', () => {
    for (let i = 0; i < 55; i++) {
      saveVisionSession(makeSession(`s${String(i).padStart(3, '0')}`));
    }
    const sessions = listVisionSessions();
    expect(sessions.length).toBeLessThanOrEqual(50);
    // 最旧的 s000 已被淘汰
    expect(sessions.some(s => s.id === 's000')).toBe(false);
    expect(sessions[0].id).toBe('s054');
  });

  it('损坏的 localStorage 数据不抛错', () => {
    localStorage.setItem('vision_sessions_v1', 'not-json');
    expect(listVisionSessions()).toEqual([]);
  });
});

describe('similarityToSnapshot 评分摘要', () => {
  it('只保留分值与 Top 差异（不存大对象）', () => {
    const report: SimilarityReport = {
      final_score: 0.87,
      scores: { subject: 0.9, composition: 0.85, style: 0.88, lighting: 0.8, color: 0.86, objects: 0.84, ocr: null },
      local_color: 0.86,
      local_composition: 0.83,
      differences: Array.from({ length: 12 }, (_, i) => ({ kind: 'missing' as const, text: `差异${i}` })),
      recommendations: [],
      effective_weights: { subject: 0.3, composition: 0.2, style: 0.15, lighting: 0.1, color: 0.1, objects: 0.15, ocr: 0 },
    };
    const snapshot = similarityToSnapshot(report);
    expect(snapshot.final_score).toBe(0.87);
    expect(snapshot.ocr).toBeNull();
    expect(snapshot.topDifferences).toHaveLength(6);
    expect(snapshot.topDifferences[0]).toBe('差异0');
  });
});
