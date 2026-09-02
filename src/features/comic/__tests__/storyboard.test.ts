/**
 * 分镜修复层测试（Phase 6，验收 G / K）：
 *  - id/order 重排对齐 + 对白 panelId 跟随映射（LLM id 漂移容错）；
 *  - 未知角色剔除（防 prompt 编译悬空引用）；
 *  - panelCount 契约：超出截断（连带对白）、不足回写格数；
 *  - 空分镜 fatal；修复动作必须报告（不静默吞）。
 * 另含 planComicStory / draftStoryboard 服务契约（验收 G 的 LLM 侧）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { repairStoryboard } from '../storyboard';
import { normalizeComicCharacter, normalizeComicSkill } from '../normalize';
import type { ComicCharacter, ComicSkill, ComicStory } from '../types';

function makeCharacters(): ComicCharacter[] {
  return [
    normalizeComicCharacter({ id: 'char-1', name: '汤圆', status: 'confirmed' })!,
  ];
}

function makeStory(panelCount = 2): ComicStory {
  return {
    title: '周一例会', topic: '例会', summary: '又延期了',
    characterIds: ['char-1'], beats: ['开场', '反转'],
    endingType: 'twist', panelCount,
  };
}

describe('repairStoryboard', () => {
  it('标准输入零修复直通', () => {
    const result = repairStoryboard(
      makeStory(),
      [
        { id: 'panel-0', order: 0, scene: '开场', characterIds: ['char-1'] },
        { id: 'panel-1', order: 1, scene: '反转', characterIds: ['char-1'] },
      ],
      [{ id: 'd1', panelId: 'panel-0', text: '又开会' }],
      makeCharacters(),
    );
    expect(result.report.repairs).toEqual([]);
    expect(result.report.fatal).toBe(false);
    expect(result.panels).toHaveLength(2);
    expect(result.dialogues).toHaveLength(1);
  });

  it('id 漂移 / order 乱序：重排对齐且对白 panelId 跟随映射', () => {
    const result = repairStoryboard(
      makeStory(),
      [
        { id: 'sb-7', order: 1, scene: '反转', characterIds: ['char-1'] },
        { id: 'sb-3', order: 0, scene: '开场', characterIds: ['char-1'] },
      ],
      [
        { id: 'd1', panelId: 'sb-3', text: '开场台词' },
        { id: 'd2', panelId: 'sb-7', text: '反转台词' },
      ],
      makeCharacters(),
    );
    expect(result.panels.map(panel => panel.id)).toEqual(['panel-0', 'panel-1']);
    expect(result.panels.map(panel => panel.scene)).toEqual(['开场', '反转']);
    expect(result.dialogues.map(dialogue => dialogue.text)).toEqual(['开场台词', '反转台词']);
    expect(result.dialogues[0]!.panelId).toBe('panel-0');
    expect(result.dialogues[1]!.panelId).toBe('panel-1');
    expect(result.report.repairs.length).toBeGreaterThan(0);
    expect(result.report.repairs.join()).toContain('重排');
  });

  it('未知角色剔除并报告', () => {
    const result = repairStoryboard(
      makeStory(),
      [{ id: 'panel-0', order: 0, scene: 's', characterIds: ['char-1', 'ghost-9'] }],
      [],
      makeCharacters(),
    );
    expect(result.panels[0]!.characterIds).toEqual(['char-1']);
    expect(result.report.repairs.join()).toContain('未知角色');
  });

  it('超出格数约定截断，连带剔除孤儿对白', () => {
    const result = repairStoryboard(
      makeStory(2),
      [
        { id: 'panel-0', order: 0, scene: 'a' },
        { id: 'panel-1', order: 1, scene: 'b' },
        { id: 'panel-2', order: 2, scene: 'c' },
      ],
      [
        { id: 'd0', panelId: 'panel-0', text: 't0' },
        { id: 'd2', panelId: 'panel-2', text: 't2' },
      ],
      makeCharacters(),
    );
    expect(result.panels).toHaveLength(2);
    expect(result.dialogues.map(dialogue => dialogue.id)).toEqual(['d0']);
    expect(result.report.repairs.join()).toContain('截断');
  });

  it('少于格数约定：回写 story.panelCount 而非虚构分镜', () => {
    const result = repairStoryboard(
      makeStory(4),
      [{ id: 'panel-0', order: 0, scene: '只有一格' }],
      [{ id: 'd0', panelId: 'panel-0', text: 't' }],
      makeCharacters(),
    );
    expect(result.story.panelCount).toBe(1);
    expect(result.report.repairs.join()).toContain('回写');
  });

  it('空分镜 fatal（调用方中止应用）', () => {
    const result = repairStoryboard(makeStory(), [], [], makeCharacters());
    expect(result.report.fatal).toBe(true);
    expect(result.panels).toEqual([]);
  });

  it('完全无法映射的对白被剔除并报告', () => {
    const result = repairStoryboard(
      makeStory(),
      [{ id: 'panel-0', order: 0, scene: 's' }],
      [
        { id: 'ok', panelId: 'panel-0', text: '有效' },
        { id: 'bad', panelId: 'nowhere', text: '孤儿' },
      ],
      makeCharacters(),
    );
    expect(result.dialogues).toHaveLength(1);
    expect(result.report.repairs.join()).toContain('对白');
  });
});

// ---------------------------------------------------------------------------
// planComicStory / draftStoryboard 服务契约（LLM 侧，验收 G）
// ---------------------------------------------------------------------------

vi.mock('../../../services/api', () => ({
  api: { runAgentRequest: vi.fn() },
}));
vi.mock('../../../features/aiProviders/providerError', () => ({
  buildProviderError: vi.fn(() => ({})),
  providerErrorCompact: vi.fn(() => 'provider error'),
}));
vi.mock('../../../features/aiRouting/resolveModelForRole', () => ({
  resolveModelForRole: vi.fn(() => ({
    ok: true,
    connection: {
      baseUrl: 'https://api.example.com/v1', token: 'tok', model: 'glm-4.6',
      profileId: 'p1', profileName: '测试', providerType: 'openai_compatible',
      modelEntity: { display_name: 'GLM-4.6' },
    },
    resolved: {},
  })),
  recordAiRoleUsage: vi.fn(),
}));
vi.mock('../../../features/aiRouting/aiRoutingLog', () => ({ logAiTransport: vi.fn() }));

import { api } from '../../../services/api';
import { draftStoryboard, planComicStory } from '../../../services/comicPlanner';

const runMock = api.runAgentRequest as unknown as ReturnType<typeof vi.fn>;

function replyWith(payload: unknown): void {
  runMock.mockResolvedValueOnce({ ok: true, reply: JSON.stringify(payload) });
}

function makeSkill(): ComicSkill {
  return normalizeComicSkill({
    name: '职场吐槽四格', comicForm: '四格漫画', layout: { panelCount: 2, arrangement: 'vertical_2' },
    characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('planComicStory', () => {
  it('归一化故事并剔除未知角色 id', async () => {
    replyWith({
      title: '例会又延期', topic: '例会', summary: '周五例会第三次延期',
      characterIds: ['char-1', 'ghost'], beats: ['开场', '反转'],
      endingType: 'punchline', panelCount: 2,
    });
    const outcome = await planComicStory({
      skill: makeSkill(),
      characters: makeCharacters(),
      requirement: '写一期例会延期的漫画',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.story.characterIds).toEqual(['char-1']);
    expect(outcome.story.beats).toHaveLength(2);
  });

  it('beats 与 panelCount 不符：以 beats 为准回写，不硬造节拍', async () => {
    replyWith({
      title: 'T', beats: ['只有一拍'], panelCount: 5, characterIds: [],
    });
    const outcome = await planComicStory({
      skill: makeSkill(), characters: makeCharacters(), requirement: 'x',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.story.panelCount).toBe(1);
  });

  it('缺 beats 重试后报错', async () => {
    replyWith({ title: 'T', beats: [] });
    replyWith({ title: 'T', beats: [] });
    const outcome = await planComicStory({
      skill: makeSkill(), characters: makeCharacters(), requirement: 'x',
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('draftStoryboard', () => {
  it('分镜归一 + id 重排 + 对白映射 + 未知角色剔除', async () => {
    replyWith({
      panels: [
        { id: 'sb-a', order: 0, scene: '办公室清晨', characterIds: ['char-1', 'ghost'], shotType: '全景' },
        { id: 'sb-b', order: 1, scene: '主角崩溃', characterIds: ['char-1'] },
      ],
      dialogues: [
        { panelId: 'sb-a', speakerId: 'char-1', text: '又开会', position: { x: 0.5, y: 0.2 } },
        { panelId: 'sb-b', speakerId: 'narrator', type: 'caption', text: '下午五点' },
      ],
    });
    const outcome = await draftStoryboard({
      skill: makeSkill(), story: makeStory(), characters: makeCharacters(),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.panels.map(panel => panel.id)).toEqual(['panel-0', 'panel-1']);
    expect(outcome.panels[0]!.characterIds).toEqual(['char-1']);
    expect(outcome.dialogues).toHaveLength(2);
    expect(outcome.dialogues[0]!.panelId).toBe('panel-0');
  });

  it('分镜数量与格数不符 → 重试后仍不符 → 报错（数量契约）', async () => {
    replyWith({ panels: [{ id: 'p0', order: 0, scene: 's' }], dialogues: [{ panelId: 'p0', text: 't' }] });
    replyWith({ panels: [], dialogues: [] });
    const outcome = await draftStoryboard({
      skill: makeSkill(), story: makeStory(), characters: makeCharacters(),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('分镜数量');
  });

  it('对白全被剔除视为无效输出（每格至少要能配文字层）', async () => {
    replyWith({
      panels: [
        { id: 'panel-0', order: 0, scene: 'a' },
        { id: 'panel-1', order: 1, scene: 'b' },
      ],
      dialogues: [{ panelId: 'nowhere', text: '孤儿' }],
    });
    replyWith({
      panels: [
        { id: 'panel-0', order: 0, scene: 'a' },
        { id: 'panel-1', order: 1, scene: 'b' },
      ],
      dialogues: [],
    });
    const outcome = await draftStoryboard({
      skill: makeSkill(), story: makeStory(), characters: makeCharacters(),
    });
    expect(outcome.ok).toBe(false);
  });
});
