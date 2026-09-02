/**
 * directComicDialogues（AI 对白导演 · Planner 模式）解析与模式过滤单测
 * （V4.2.13 残留修复补齐）：不触达真实 Tauri IPC / Provider——mock
 * runAgentRequest 走 runWithRetry 全链。覆盖：proposal 解析映射 / speaker 名
 * 未命中回退 / 样式与类型白名单回退 / 无效条目丢弃 / panel 模式目标格过滤与
 * 缺失报错 / fill 模式已有对白过滤与全满报错 / maxChars 解析层截断 /
 * prompt「只写对白、不得改写故事」铁律注入。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api', () => ({
  api: { runAgentRequest: vi.fn() },
}));
vi.mock('../../features/aiProviders/providerError', () => ({
  buildProviderError: vi.fn(() => ({})),
  providerErrorCompact: vi.fn(() => 'provider error'),
}));
vi.mock('../../features/aiRouting/resolveModelForRole', () => ({
  resolveModelForRole: vi.fn(() => ({
    ok: true,
    connection: {
      baseUrl: 'https://api.example.com/v1',
      token: 'tok',
      model: 'glm-4.6',
      profileId: 'p1',
      profileName: '测试供应商',
      providerType: 'openai_compatible',
      modelEntity: { display_name: 'GLM-4.6' },
    },
    resolved: {},
  })),
  recordAiRoleUsage: vi.fn(),
}));
vi.mock('../../features/aiRouting/aiRoutingLog', () => ({ logAiTransport: vi.fn() }));

import { api } from '../api';
import { directComicDialogues } from '../comicPlanner';

const runMock = api.runAgentRequest as unknown as ReturnType<typeof vi.fn>;

function replyWith(payload: unknown): void {
  runMock.mockResolvedValueOnce({ ok: true, reply: JSON.stringify(payload) });
}

function lastRequest(): Record<string, unknown> {
  return runMock.mock.calls[runMock.mock.calls.length - 1]![0] as Record<string, unknown>;
}

const SKILL = { name: '鸭梨山大', dialogueStyle: '短句口语化', humorStyle: '自嘲冷幽默' };
const PANELS = [
  { id: 'p0', order: 0, scene: '鸭梨山大瘫在工位', characterIds: ['c1'] },
  { id: 'p1', order: 1, scene: '老板抱着新需求走来', characterIds: ['c1', 'c2'] },
];
const CHARACTERS = [
  { id: 'c1', name: '鸭梨山大', role: '主角·社畜' },
  { id: 'c2', name: '老板', role: '上司' },
];

function baseInput() {
  return {
    skill: SKILL,
    story: null,
    panels: PANELS,
    characters: CHARACTERS,
    existingDialogues: [] as Array<{ panelId: string; text: string }>,
    mode: 'page' as const,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('directComicDialogues 解析', () => {
  it('标准输出：order/说话人/文字/类型/样式建议一一映射，prompt 注入「不得改写故事」铁律', async () => {
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '需求又来了？', type: 'speech', suggestedStyle: 'spiky' },
      { order: 1, speaker: 'narrator', text: '深夜十一点。', type: 'caption', suggestedStyle: 'box-light' },
    ] });
    const outcome = await directComicDialogues(baseInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposals).toEqual([
      { order: 0, speakerId: 'c1', text: '需求又来了？', type: 'speech', suggestedStyle: 'spiky' },
      { order: 1, speakerId: 'narrator', text: '深夜十一点。', type: 'caption', suggestedStyle: 'box-light' },
    ]);
    const request = lastRequest();
    expect(String(request.system_prompt)).toContain('不得改写故事剧情');
    expect(String(request.system_prompt)).toContain('不得发明输入之外的新情节与新角色');
  });

  it('容错：speaker 未命中回退 narrator，样式/类型出白名单回退，空文字与无效 order 丢弃', async () => {
    replyWith({ panels: [
      { order: 0, speaker: '神秘人', text: '你是谁？', type: 'song', suggestedStyle: 'neon-bubble' },
      { order: 1, speaker: '老板', text: '', type: 'speech', suggestedStyle: 'rounded' },
      { order: 7, speaker: '老板', text: '这格不存在', type: 'speech', suggestedStyle: 'rounded' },
      'garbage',
    ] });
    const outcome = await directComicDialogues(baseInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposals).toEqual([
      { order: 0, speakerId: 'narrator', text: '你是谁？', type: 'speech', suggestedStyle: 'rounded' },
    ]);
  });

  it('全部条目无效 → ok:false（自动 repair 一轮后仍失败）', async () => {
    replyWith({ panels: [{ order: 9, speaker: '老板', text: '无效', type: 'speech', suggestedStyle: 'rounded' }] });
    replyWith({ panels: [] });
    const outcome = await directComicDialogues(baseInput());
    expect(outcome.ok).toBe(false);
    expect(runMock).toHaveBeenCalledTimes(2); // initial + repair
  });

  it('maxChars 解析层硬截断（V4.2.13 残留：此前固定 60 字，与所选上限脱钩）', async () => {
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '一二三四五六七八九十一二三四五六七八九十一二三四五', type: 'speech', suggestedStyle: 'rounded' },
    ] });
    const outcome = await directComicDialogues({ ...baseInput(), maxCharsHint: 16 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposals[0]!.text).toBe('一二三四五六七八九十一二三四五六');
  });
});

describe('directComicDialogues 模式过滤', () => {
  it('fill：只保留没有对白的格；空文字对白不算「已有对白」（与 apply 铁律同语义）', async () => {
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '已有格的建议', type: 'speech', suggestedStyle: 'rounded' },
      { order: 1, speaker: '鸭梨山大', text: '空白格的建议', type: 'speech', suggestedStyle: 'rounded' },
    ] });
    const outcome = await directComicDialogues({
      ...baseInput(),
      mode: 'fill',
      existingDialogues: [{ panelId: 'p0', text: '旧对白' }],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposals.map(item => item.order)).toEqual([1]);

    // p0 只有空文字对白（内存编辑态）→ 仍是 fill 的合法目标，正常发起模型调用
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '补上空格', type: 'speech', suggestedStyle: 'rounded' },
    ] });
    const withEmpty = await directComicDialogues({
      ...baseInput(),
      mode: 'fill',
      existingDialogues: [
        { panelId: 'p0', text: '' },
        { panelId: 'p1', text: '旧对白' },
      ],
    });
    expect(withEmpty.ok).toBe(true);
  });

  it('fill 全满：零成本前置守卫——零模型调用直接给出可行动错误（不再白跑两轮再报「请重试」）', async () => {
    const full = await directComicDialogues({
      ...baseInput(),
      mode: 'fill',
      existingDialogues: [
        { panelId: 'p0', text: '旧对白' },
        { panelId: 'p1', text: '旧对白' },
      ],
    });
    expect(full.ok).toBe(false);
    if (full.ok) return;
    expect(full.error).toContain('所有格都已有对白');
    expect(full.error).toContain('重新生成本格');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('零格与目标格不存在：同样前置拦截，零模型调用', async () => {
    const empty = await directComicDialogues({ ...baseInput(), panels: [] });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.error).toContain('还没有可写对白的分镜');

    const badTarget = await directComicDialogues({ ...baseInput(), mode: 'panel', targetPanelOrder: 9 });
    expect(badTarget.ok).toBe(false);
    if (badTarget.ok) return;
    expect(badTarget.error).toContain('目标格不存在');
    expect(runMock).not.toHaveBeenCalled();
  });

  it('panel：只保留目标格；模型没输出目标格 → repair 后仍报错', async () => {
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '别的格', type: 'speech', suggestedStyle: 'rounded' },
      { order: 1, speaker: '老板', text: '目标格新对白', type: 'speech', suggestedStyle: 'rect' },
    ] });
    const outcome = await directComicDialogues({ ...baseInput(), mode: 'panel', targetPanelOrder: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.proposals).toEqual([
      { order: 1, speakerId: 'c2', text: '目标格新对白', type: 'speech', suggestedStyle: 'rect' },
    ]);

    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: '只有别的格', type: 'speech', suggestedStyle: 'rounded' },
    ] });
    replyWith({ panels: [
      { order: 0, speaker: '鸭梨山大', text: 'repair 还是别的格', type: 'speech', suggestedStyle: 'rounded' },
    ] });
    const missing = await directComicDialogues({ ...baseInput(), mode: 'panel', targetPanelOrder: 1 });
    expect(missing.ok).toBe(false);
    expect(runMock).toHaveBeenCalledTimes(3); // 成功 1 次 + 失败任务 initial + repair
  });
});
