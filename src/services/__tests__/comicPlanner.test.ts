/**
 * ComicPlannerService（Phase 3）——解析与契约单测：不触达真实 Tauri IPC / Provider 配置。
 * 覆盖：概念归一 / 数量严格校验重试 / Skill 起草 noText 铁律 / 补丁白名单 /
 * 角色起草与补丁 / LLM 主动报错形态（{"ok":false,"reason"} 不重试、原样透传）。
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
import {
  draftComicCharacter,
  draftComicSkill,
  patchComicCharacter,
  patchComicPanel,
  patchComicSkill,
  recommendComicConcepts,
} from '../comicPlanner';
import { GLM53_FULL_REPLY, GLM53_TRUNCATED_REPLY } from './comicPlanner.fixtures';
import { buildStoryDraftFromConcept } from '../../features/comic/domain';
import { comicPresentationLabel, resolveConceptPresentation } from '../../features/comic/presentation';

const runMock = api.runAgentRequest as unknown as ReturnType<typeof vi.fn>;

function replyWith(payload: unknown): void {
  runMock.mockResolvedValueOnce({ ok: true, reply: JSON.stringify(payload) });
}

function lastRequest(): Record<string, unknown> {
  return runMock.mock.calls[runMock.mock.calls.length - 1]![0] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recommendComicConcepts', () => {
  it('标准输出：归一化并返回全部方案', async () => {
    replyWith({
      concepts: [
        {
          name: '职场吐槽四格', reason: '匹配打工人自嘲需求', comicForm: '四格漫画',
          visualStyle: '简笔粗线，低饱和暖色', storyPattern: '铺垫 → 冲突 → 反转',
          layout: { panelCount: 4, arrangement: 'grid_4', description: '田字四格' },
          characters: [{ name: '汤圆', role: '主角', displayRule: '' }],
          tone: '搞笑', examplePremise: '周一例会又双叒延期了',
        },
        {
          name: '产品经理冷漫', reason: '冷幽默单格', comicForm: '单格讽刺',
          layout: { panelCount: 99 }, characters: 'garbage',
        },
        { name: '条漫日记', comicForm: '条漫', layout: {} },
      ],
    });
    const outcome = await recommendComicConcepts({ requirement: '做一只打工猫的漫画' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts).toHaveLength(3);
    expect(outcome.concepts[0]!.characters).toEqual([
      { name: '汤圆', role: '主角', displayRule: undefined },
    ]);
    // 缺省容错：layout / characters / arrangement 落默认
    //（panelCount 99 越界钳到 12；layout 缺省回落 4——四格是最常见形式）
    expect(outcome.concepts[1]!.layout.panelCount).toBe(12);
    expect(outcome.concepts[1]!.layout.arrangement).toBe('custom');
    expect(outcome.concepts[1]!.characters).toEqual([]);
    expect(outcome.concepts[2]!.layout.panelCount).toBe(4);
    expect(outcome.modelName).toBe('GLM-4.6');
  });

  it('V4.2.7 Story-first 形状：fullStory / punchline / storyboardBeats 保留；grid_9 / multi_page 可用', async () => {
    replyWith({
      concepts: [
        {
          id: 'concept-a', name: '四格冷笑话', storyTitle: '《小鸭为什么不怕冷？》',
          oneLineStory: '冬天朋友问小鸭为什么不冷，小鸭说因为我自带羽绒服。',
          fullStory: '小鸭站在结冰的池塘边发呆。朋友缩着脖子问：你不冷吗？小鸭一本正经地摇头。朋友追问秘密，小鸭拍拍自己蓬松的羽毛说：因为我自带羽绒服。',
          punchline: '因为我自带羽绒服。',
          characters: [{ name: '小鸭', role: '主角', displayRule: '' }],
          storyboardBeats: [
            { order: 1, title: '冰面小鸭', summary: '小鸭站在结冰的池塘边', characters: ['小鸭'] },
            { order: 2, title: '朋友提问', summary: '朋友问你不冷吗', characters: ['朋友'] },
            { order: 3, title: '小鸭回答', summary: '小鸭认真说不冷', characters: ['小鸭'] },
            { order: 4, title: '冷笑话', summary: '因为我自带羽绒服', characters: ['小鸭'] },
          ],
          comicForm: '四格漫画',
          layout: { panelCount: 4, arrangement: 'grid_4' },
          tone: '冷幽默', reason: '适配朋友圈段子',
        },
        {
          id: 'concept-b', name: '多页对话', comicForm: '多页对话漫画',
          layout: { panelCount: 4, arrangement: 'multi_page', pageCount: 4 },
          storyboardBeats: [{ order: 1, title: '', summary: '第一句' }, { garbage: true }, { order: 3, title: '第三拍', summary: '' }],
        },
        { id: 'concept-c', name: '九宫格', comicForm: '九宫格漫画', layout: { panelCount: 9, arrangement: 'grid_9' } },
      ],
    });
    const outcome = await recommendComicConcepts({ requirement: '我需要一个小鸭子的冷笑话' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [a, b, c] = outcome.concepts;
    expect(a!.fullStory).toContain('羽绒服');
    expect(a!.punchline).toBe('因为我自带羽绒服。');
    expect(a!.storyboardBeats).toHaveLength(4);
    expect(a!.storyboardBeats[0]).toEqual({
      order: 1, title: '冰面小鸭', summary: '小鸭站在结冰的池塘边', characters: ['小鸭'],
    });
    // 节拍容错：坏项剔除，order 重排连续化（1..n），空 summary 但有 title 保留
    expect(b!.layout.arrangement).toBe('multi_page');
    expect(b!.layout.pageCount).toBe(4);
    expect(b!.storyboardBeats.map(beat => beat.order)).toEqual([1, 2]);
    expect(b!.storyboardBeats[1]!.title).toBe('第三拍');
    expect(c!.layout.arrangement).toBe('grid_9');
    expect(c!.layout.panelCount).toBe(9);
  });

  it('旧响应兼容：缺故事字段回落（storyTitle→name / oneLineStory→examplePremise / beats 空）', async () => {
    replyWith({
      concepts: [
        {
          name: '职场吐槽四格', comicForm: '四格漫画', examplePremise: '周一例会又双叒延期了',
          layout: { panelCount: 4, arrangement: 'grid_4' },
        },
        { name: 'B', comicForm: '条漫' },
        { name: 'C', comicForm: '单格' },
      ],
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const legacy = outcome.concepts[0]!;
    expect(legacy.storyTitle).toBe('职场吐槽四格');
    expect(legacy.oneLineStory).toBe('周一例会又双叒延期了');
    expect(legacy.fullStory).toBe('');
    expect(legacy.punchline).toBe('');
    expect(legacy.storyboardBeats).toEqual([]);
    expect(legacy.dialogueStyle).toBe('');
    expect(typeof legacy.id).toBe('string');
    expect(legacy.id.length).toBeGreaterThan(0);
  });

  it('Prompt 为 Story-first：先故事后形式 / 三方案本质不同 / 全量 arrangement 枚举', async () => {
    replyWith({
      concepts: [
        { name: 'A', comicForm: '四格' },
        { name: 'B', comicForm: '条漫' },
        { name: 'C', comicForm: '单格' },
      ],
    });
    await recommendComicConcepts({ requirement: 'x' });
    const systemPrompt = String(lastRequest().system_prompt);
    for (const marker of ['storyTitle', 'oneLineStory', 'fullStory', 'punchline', 'storyboardBeats', 'dialogueStyle']) {
      expect(systemPrompt).toContain(marker);
    }
    // §十八：创作顺序 Story → Characters → Punchline → Beats → Presentation → Style
    expect(systemPrompt).toContain('先把故事写完');
    expect(systemPrompt.indexOf('storyTitle')).toBeLessThan(systemPrompt.indexOf('visualStyle'));
    // §十二：三个方案故事本身必须不同
    expect(systemPrompt).toContain('必须本质不同');
    // §三：全量布局枚举（9 宫格 / 左右双格 / 多页都能出现在推荐里）
    for (const arrangement of ['grid_4', 'grid_9', 'vertical_2', 'horizontal_2', 'vertical_3', 'single', 'multi_page']) {
      expect(systemPrompt).toContain(arrangement);
    }
  });

  it('数量不符自动重试 1 次，仍不符则报错（绝不静默接受错误数量）', async () => {
    replyWith({ concepts: [{ name: '只有一个', comicForm: '四格' }] });
    replyWith({ concepts: [{ name: '还是只有一个', comicForm: '四格' }] });
    const outcome = await recommendComicConcepts({ requirement: 'x', count: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('数量');
    expect(runMock).toHaveBeenCalledTimes(2);
  });

  it('重试后数量正确则成功', async () => {
    replyWith({ concepts: [] });
    replyWith({
      concepts: [
        { name: 'A', comicForm: '四格', examplePremise: '小鸭的冷笑话' },
        { name: 'B', comicForm: '条漫' },
      ],
    });
    const outcome = await recommendComicConcepts({ requirement: 'x', count: 2 });
    expect(outcome.ok).toBe(true);
  });

  it('V4.2.7 §六：所有方案都完全没有故事 → 判失败重试，重试仍无故事 → 报错（不静默 PASS）', async () => {
    replyWith({
      concepts: [
        { name: 'A', comicForm: '四格' },
        { name: 'B', comicForm: '条漫' },
        { name: 'C', comicForm: '单格' },
      ],
    });
    replyWith({
      concepts: [
        { name: 'A', comicForm: '四格' },
        { name: 'B', comicForm: '条漫' },
        { name: 'C', comicForm: '单格' },
      ],
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('方案');
    expect(runMock).toHaveBeenCalledTimes(2);
    // 修复指令明确告诉模型缺什么
    const repairContent = String(runMock.mock.calls[1]![0]!.messages[0]!.content);
    expect(repairContent).toContain('修复指令');
    expect(repairContent).toContain('故事内容');
  });

  it('非 JSON 回复重试后报错', async () => {
    runMock.mockResolvedValueOnce({ ok: true, reply: '我觉得用户应该自己画' });
    runMock.mockResolvedValueOnce({ ok: true, reply: '仍然不是 JSON' });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(false);
  });
});

describe('LLM 主动报错形态（{"ok":false,"reason"}）', () => {
  it('不重试、reason 原样透传', async () => {
    replyWith({ ok: false, reason: '需求涉及真实公众人物，拒绝执行' });
    const outcome = await draftComicSkill({ requirement: 'x', concept: {} as never });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('真实公众人物');
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

describe('draftComicSkill', () => {
  it('起草成功并强制 noText 铁律', async () => {
    replyWith({
      name: '职场吐槽四格',
      comicForm: '四格漫画',
      generationRules: { noText: false, negativeConstraints: ['水印'] },
      characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
      promptTemplate: '{{comic.visualStyle}}，{{panel.scene}}',
    });
    const outcome = await draftComicSkill({
      requirement: '打工人漫画',
      concept: { name: '职场吐槽四格' } as never,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skill.name).toBe('职场吐槽四格');
    expect(outcome.skill.generationRules.noText).toBe(true);
    expect(outcome.skill.characterSlots).toHaveLength(1);
  });

  it('缺必选槽位（校验失败）重试后报错', async () => {
    replyWith({ name: '有名但没槽位', comicForm: '四格' });
    replyWith({ name: '还是没有', comicForm: '四格', characterSlots: [{ slotId: 'a', name: '配角', required: false }] });
    const outcome = await draftComicSkill({ requirement: 'x', concept: {} as never });
    expect(outcome.ok).toBe(false);
  });

  it('V4.2.7 §十五：展示形式确定性写入（concept.layout 覆盖 LLM 输出，不依赖复述）', async () => {
    replyWith({
      name: '小鸭冷笑话',
      comicForm: '多页对话漫画',
      layout: { panelCount: 9, arrangement: 'grid_9' }, // LLM 跑偏：改成了九宫格
      characterSlots: [{ slotId: 'duck', name: '小鸭', required: true }],
    });
    const outcome = await draftComicSkill({
      requirement: '我需要一个小鸭子的冷笑话',
      concept: {
        id: 'concept-a',
        name: '多页对话',
        storyTitle: '《小鸭为什么不怕冷？》',
        oneLineStory: '一句话',
        fullStory: '完整故事',
        punchline: '自带羽绒服',
        reason: '', comicForm: '多页对话漫画',
        visualStyle: '简笔', storyPattern: '', dialogueStyle: '',
        layout: { panelCount: 4, arrangement: 'multi_page', pageCount: 4 },
        characters: [], storyboardBeats: [], tone: '',
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skill.layout.arrangement).toBe('multi_page');
    expect(outcome.skill.layout.panelCount).toBe(4);
    expect(outcome.skill.layout.pageCount).toBe(4);
  });
});

describe('patchComicSkill（白名单）', () => {
  it('白名单外字段被过滤；characterSlot 缺 slotId 被过滤', async () => {
    replyWith({
      patches: [
        { field: 'humorStyle', value: '冷幽默', reason: '用户要求' },
        { field: 'id', value: 'hijack' },
        { field: 'characterSlot.displayRule', value: '不露脸' }, // 缺 slotId
        { field: 'characterSlot.displayRule', value: '仅手部与麦克风', slotId: 'reporter' },
      ],
    });
    const outcome = await patchComicSkill({
      skill: { characterSlots: [] } as never,
      instruction: '记者不要露脸，幽默改冷一点',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.patches.map(patch => patch.field)).toEqual(['humorStyle', 'characterSlot.displayRule']);
    expect(outcome.patches[1]!.slotId).toBe('reporter');
  });

  it('全部补丁非法 → 重试后报错', async () => {
    replyWith({ patches: [{ field: 'id', value: 'x' }] });
    replyWith({ patches: 'garbage' });
    const outcome = await patchComicSkill({ skill: {} as never, instruction: 'x' });
    expect(outcome.ok).toBe(false);
  });
});

describe('draftComicCharacter', () => {
  it('起草成功并归一化', async () => {
    replyWith({
      name: '汤圆',
      description: '一只圆脸打工猫',
      role: '主角',
      appearance: '奶油黄短毛圆脸猫，白领结，黑豆眼',
      immutableTraits: ['奶油黄短毛', '圆脸', '白领结'],
      mutableTraits: ['表情', '动作', '手持物'],
    });
    const outcome = await draftComicCharacter({
      skill: {
        characterSlots: [{ slotId: 'hero', name: '主角', required: true }],
      } as never,
      slotId: 'hero',
      notes: '要可爱一点',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.character.name).toBe('汤圆');
    expect(outcome.character.immutableTraits).toEqual(['奶油黄短毛', '圆脸', '白领结']);
    expect(outcome.character.status).toBe('draft');
  });

  it('槽位不存在直接报错（不调 LLM）', async () => {
    const outcome = await draftComicCharacter({
      skill: { characterSlots: [] } as never,
      slotId: 'ghost',
    });
    expect(outcome.ok).toBe(false);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('缺名字重试后报错', async () => {
    replyWith({ description: '没有名字的猫' });
    replyWith({ description: '还是没有名字' });
    const outcome = await draftComicCharacter({
      skill: { characterSlots: [{ slotId: 'hero', name: '主角', required: true }] } as never,
      slotId: 'hero',
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('patchComicCharacter（白名单）', () => {
  it('只保留角色白名单字段（status/id 不可碰）', async () => {
    replyWith({
      patches: [
        { field: 'appearance', value: '加了红色贝雷帽', reason: '加帽子' },
        { field: 'status', value: 'locked' },
        { field: 'id', value: 'evil' },
        { field: 'immutableTraits', value: ['奶油黄短毛', '红色贝雷帽'] },
      ],
    });
    const outcome = await patchComicCharacter({
      character: { name: '汤圆' } as never,
      instruction: '给汤圆加一顶红色贝雷帽',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.patches.map(patch => patch.field)).toEqual(['appearance', 'immutableTraits']);
  });
});

describe('patchComicPanel（§38.2 大白话改单格，白名单）', () => {
  it('只保留分镜白名单字段（order/generationStatus/compiledPrompt 不可碰）', async () => {
    replyWith({
      patches: [
        { field: 'scene', value: '摔到草地', reason: '用户要求别掉水里' },
        { field: 'order', value: 9 },
        { field: 'generationStatus', value: 'completed' },
        { field: 'environmentText', value: null },
      ],
    });
    const outcome = await patchComicPanel({
      panel: { order: 2, scene: '掉进水里', environmentText: '例会室 3A' } as never,
      instruction: '第 3 格不要掉水里，改成摔到草地；这格不要画面内文字',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.patches.map(patch => patch.field)).toEqual(['scene', 'environmentText']);
    expect(outcome.patches[1]!.value).toBeNull();
    const request = lastRequest() as { feature?: string; messages?: Array<{ content?: string }> };
    expect(request.feature).toBe('comic-panel-patch');
    // userContent 携带这一格的 JSON 投影 + 用户指令原文
    const userText = request.messages?.[0]?.content ?? '';
    expect(userText).toContain('当前这一格分镜（JSON）：');
    expect(userText).toContain('用户修改指令：');
  });

  it('全部补丁非法 → 重试后报错（绝不静默接受）', async () => {
    replyWith({ patches: [{ field: 'nope', value: 1 }] });
    replyWith({ patches: [{ field: 'still-nope', value: 2 }] });
    const outcome = await patchComicPanel({
      panel: { order: 0, scene: 'x' } as never,
      instruction: '改一下',
    });
    expect(outcome.ok).toBe(false);
  });
});

describe('通道契约（role=comic_planner，零计费 BYOK）', () => {
  it('runAgentRequest 携带 role/feature/system_prompt/messages', async () => {
    replyWith({
      patches: [{ field: 'humorStyle', value: '冷幽默' }],
    });
    await patchComicSkill({ skill: {} as never, instruction: 'x' });
    const request = lastRequest();
    expect(request.role).toBe('comic_planner');
    expect(request.mode).toBe('chat');
    expect(request.feature).toBe('comic-skill-patch');
    expect(typeof request.system_prompt).toBe('string');
    expect(Array.isArray(request.messages)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// V4.2.7 §十三：真实解析 fixtures + 定向修复重试（GLM-5.3 截断根因回归）
// ---------------------------------------------------------------------------

/** 三个最小合法方案（供格式容错用例做基座，改形状不改故事存在性）。 */
function threeConcepts(extra: (index: number) => Record<string, unknown>): Record<string, unknown>[] {
  return [0, 1, 2].map(index => ({
    name: `方案${index + 1}`,
    comicForm: '四格漫画',
    fullStory: `第${index + 1}个完整故事，从开头讲到结尾。`,
    ...extra(index),
  }));
}

describe('V4.2.7 §十三 真实 fixtures（GLM-5.3 截断根因回归）', () => {
  it('真实截断样本（finish_reason=length）→ 定向修复重试 1 次 → 仍失败并报「截断」错误', async () => {
    runMock.mockResolvedValueOnce({ ok: true, reply: GLM53_TRUNCATED_REPLY, finish_reason: 'length' });
    runMock.mockResolvedValueOnce({ ok: true, reply: GLM53_TRUNCATED_REPLY, finish_reason: 'length' });
    const outcome = await recommendComicConcepts({ requirement: '我需要讲个小鸭子冷笑话' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('截断');
    expect(runMock).toHaveBeenCalledTimes(2);
    // §七：第二次不是原样重发——user content 追加具体失败原因的修复指令
    const repairContent = String(runMock.mock.calls[1]![0]!.messages[0]!.content);
    expect(repairContent).toContain('修复指令');
    expect(repairContent).toContain('长度上限');
    expect(repairContent).toContain('我需要讲个小鸭子冷笑话'); // 原始需求保留
  });

  it('真实完整样本（max_tokens=8192）→ 一次通过，携带 8192 输出预算', async () => {
    runMock.mockResolvedValueOnce({ ok: true, reply: GLM53_FULL_REPLY, finish_reason: 'stop' });
    const outcome = await recommendComicConcepts({ requirement: '我需要讲个小鸭子冷笑话' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts).toHaveLength(3);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]![0]!.max_tokens).toBe(8192);
    // §十五：成功响应的故事 / 展示形式 / 节拍完整转移到故事草稿
    const [a, b, c] = outcome.concepts;
    expect(a!.storyTitle).toBe('《自带羽绒服的小鸭》');
    expect(a!.fullStory).toContain('羽绒服');
    expect(a!.storyboardBeats).toHaveLength(4);
    expect(b!.layout.arrangement).toBe('vertical_3');
    expect(b!.storyboardBeats).toHaveLength(6);
    expect(c!.layout.arrangement).toBe('single');
    for (const concept of outcome.concepts) {
      expect(concept.fullStory.length).toBeGreaterThan(0);
      expect(concept.storyboardBeats.length).toBeGreaterThan(0);
    }
    const storyDraft = buildStoryDraftFromConcept(a!);
    expect(storyDraft.title).toBe('《自带羽绒服的小鸭》');
    expect(storyDraft.summary).toBe(a!.fullStory);
    expect(storyDraft.beats[0]).toContain('寒冬出门');
    expect(comicPresentationLabel(resolveConceptPresentation(a!))).toContain('四宫格');
  });
});

describe('V4.2.7 §十三 有限格式容错（fence / 前后解释文字 / 旧形状）', () => {
  it('Markdown fence 包裹的 JSON 可解析', async () => {
    const payload = { concepts: threeConcepts(() => ({})) };
    runMock.mockResolvedValueOnce({
      ok: true,
      reply: `好的，以下是推荐方案：\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`\n`,
      finish_reason: 'stop',
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts).toHaveLength(3);
  });

  it('JSON 前后带解释文字可解析（只提取首个配平对象）', async () => {
    const payload = { concepts: threeConcepts(() => ({})) };
    runMock.mockResolvedValueOnce({
      ok: true,
      reply: `这是根据您的需求规划的三个方案：\n${JSON.stringify(payload)}\n\n希望对您有帮助，如需调整请告诉我。`,
      finish_reason: 'stop',
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts).toHaveLength(3);
  });

  it('旧响应的 presentation 字符串字段被忽略（展示形式仍由 layout 派生，D-101）', async () => {
    runMock.mockResolvedValueOnce({
      ok: true,
      reply: JSON.stringify({
        concepts: threeConcepts(() => ({
          presentation: '四格漫画', // legacy 字段：当前 Schema 从 layout 派生，不接受复述
          layout: { panelCount: 4, arrangement: 'grid_4' },
        })),
      }),
      finish_reason: 'stop',
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const concept = outcome.concepts[0]!;
    expect(resolveConceptPresentation(concept).pages[0]!.columns).toBe(2);
    expect(comicPresentationLabel(resolveConceptPresentation(concept))).toContain('四宫格');
  });

  it('storyboardBeats 为 string[] 时逐项转节拍对象（order 连续化）', async () => {
    runMock.mockResolvedValueOnce({
      ok: true,
      reply: JSON.stringify({
        concepts: threeConcepts(() => ({
          storyboardBeats: ['小鸭出场', '朋友提问', '小鸭回答', '抖包袱'],
        })),
      }),
      finish_reason: 'stop',
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts[0]!.storyboardBeats).toEqual([
      { order: 1, title: '', summary: '小鸭出场', characters: [] },
      { order: 2, title: '', summary: '朋友提问', characters: [] },
      { order: 3, title: '', summary: '小鸭回答', characters: [] },
      { order: 4, title: '', summary: '抖包袱', characters: [] },
    ]);
  });

  it('characters 为 string[] 时逐项转角色对象（role 落辅助角色）', async () => {
    runMock.mockResolvedValueOnce({
      ok: true,
      reply: JSON.stringify({
        concepts: threeConcepts(() => ({ characters: ['小鸭', '小熊'] })),
      }),
      finish_reason: 'stop',
    });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts[0]!.characters).toEqual([
      { name: '小鸭', role: '辅助角色', displayRule: undefined },
      { name: '小熊', role: '辅助角色', displayRule: undefined },
    ]);
  });

  it('纯解释文字（无 JSON）→ 修复指令明确指出「找不到 JSON」', async () => {
    runMock.mockResolvedValueOnce({ ok: true, reply: '我认为您应该先想清楚角色设定再画。', finish_reason: 'stop' });
    runMock.mockResolvedValueOnce({ ok: true, reply: '仍然不是 JSON', finish_reason: 'stop' });
    const outcome = await recommendComicConcepts({ requirement: 'x' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('格式异常');
    const repairContent = String(runMock.mock.calls[1]![0]!.messages[0]!.content);
    expect(repairContent).toContain('找不到 JSON');
  });
});

describe('V4.2.7 §八 requestId 诊断（一次用户动作的 initial + repair 共用一个 requestId）', () => {
  it('两次 attempt 的诊断日志携带同一 requestId，两次独立调用 requestId 不同', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // 第一次调用：数量错误 → repair → 成功（2 条 request 日志）
      runMock.mockResolvedValueOnce({ ok: true, reply: JSON.stringify({ concepts: [] }), finish_reason: 'stop' });
      runMock.mockResolvedValueOnce({
        ok: true,
        reply: JSON.stringify({ concepts: threeConcepts(() => ({})) }),
        finish_reason: 'stop',
      });
      const first = await recommendComicConcepts({ requirement: 'x' });
      expect(first.ok).toBe(true);
      // 第二次调用：一次通过（1 条 request 日志）
      runMock.mockResolvedValueOnce({
        ok: true,
        reply: JSON.stringify({ concepts: threeConcepts(() => ({})) }),
        finish_reason: 'stop',
      });
      const second = await recommendComicConcepts({ requirement: 'y' });
      expect(second.ok).toBe(true);

      const requestLines = logSpy.mock.calls
        .map(args => String(args[0]))
        .filter(line => line.startsWith('[ComicPlanner]') && line.includes('stage=request'));
      expect(requestLines).toHaveLength(3);
      const ids = requestLines.map(line => line.match(/requestId=([^\s]+)/)![1]);
      expect(ids[0]).toBe(ids[1]); // 同一动作的 initial + repair 同 id
      expect(ids[2]).not.toBe(ids[0]); // 不同动作不同 id（可区分 UI 重复提交 vs 自动重试）
      // attempt 编号可诊断
      expect(requestLines[0]).toContain('attempt=1');
      expect(requestLines[1]).toContain('attempt=2');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('诊断日志不泄漏凭据：reply 日志只含 raw_head 截断正文，无 token / base_url / authorization', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      runMock.mockResolvedValueOnce({
        ok: true,
        reply: JSON.stringify({ concepts: threeConcepts(() => ({})) }),
        finish_reason: 'stop',
      });
      await recommendComicConcepts({ requirement: 'x' });
      const logged = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logged).not.toContain('api.example.com'); // mock 的 base_url 不进日志
      // 'token=' 不是 'max_tokens=' 的子串（后者是 tokens=），可精确断言无凭据字段
      for (const secret of ['token=', 'authorization', 'api_key', 'Bearer']) {
        expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// V4.2.8 Presentation Constraint（§13~§22 / §57~§59 / §71）：auto / fixed 三层
// 契约（Prompt 结构化约束 / Validator 硬校验 / Repair 硬约束前言）。
// ---------------------------------------------------------------------------

/** 三个符合 fixed 约束几何的合法方案（layout / beats 精确匹配模板）。 */
function constrainedConcepts(
  arrangement: 'grid_4' | 'grid_9' | 'vertical_2' | 'horizontal_2' | 'vertical_3' | 'single' | 'multi_page',
  panelCount: number,
  options: { pageCount?: number } = {},
): Record<string, unknown>[] {
  return [0, 1, 2].map(index => ({
    id: `concept-${['a', 'b', 'c'][index]}`,
    name: `方案${index + 1}`,
    storyTitle: `《第${index + 1}个故事》`,
    oneLineStory: `第${index + 1}个故事的一句话`,
    fullStory: `第${index + 1}个完整故事，从开头讲到结尾，内容彼此不同。`,
    comicForm: '测试漫画形式',
    layout: options.pageCount !== undefined
      ? { panelCount, arrangement, pageCount: options.pageCount }
      : { panelCount, arrangement },
    storyboardBeats: Array.from({ length: panelCount }, (_, beat) => ({
      order: beat + 1,
      title: `拍${beat + 1}`,
      summary: `第${beat + 1}格发生什么`,
    })),
  }));
}

describe('V4.2.8 §91 fixed 约束（Prompt / Validator / Repair 三层一致）', () => {
  it('fixed=grid_4：system prompt 追加硬约束块；user content 携带结构化 constraint JSON（非自然语言拼接）', async () => {
    replyWith({ concepts: constrainedConcepts('grid_4', 4) });
    const outcome = await recommendComicConcepts({
      requirement: '我需要一个小鸭子的冷笑话',
      presentationConstraint: { mode: 'fixed', templateId: 'grid_4' },
    });
    expect(outcome.ok).toBe(true);
    const systemPrompt = String(lastRequest().system_prompt);
    expect(systemPrompt).toContain('用户指定的漫画形式（硬约束');
    expect(systemPrompt).toContain('「四宫格」');
    expect(systemPrompt).toContain('layout.arrangement 必须为 "grid_4"');
    const request = lastRequest() as { messages?: Array<{ content?: string }> };
    const userContent = String(request.messages![0]!.content);
    expect(userContent).toContain('{"mode":"fixed","type":"grid_4","pageCount":1,"totalPanels":4,"panelsPerPage":4}');
    expect(userContent).not.toContain('请用四格'); // §13：禁止「请用四格」式自然语言拼接
  });

  it('fixed=multi_page：结构化约束带 pageCount / 每页 1 格；三方案全部 multi_page 时通过', async () => {
    replyWith({ concepts: constrainedConcepts('multi_page', 4, { pageCount: 4 }) });
    const outcome = await recommendComicConcepts({
      requirement: '聊天记录式漫画',
      presentationConstraint: { mode: 'fixed', templateId: 'multi_page' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    for (const concept of outcome.concepts) {
      expect(concept.layout.arrangement).toBe('multi_page');
      expect(concept.storyboardBeats).toHaveLength(4);
    }
    const request = runMock.mock.calls[0]![0] as { messages?: Array<{ content?: string }> };
    const userContent = String(request.messages![0]!.content);
    expect(userContent).toContain('{"mode":"fixed","type":"multi_page","pageCount":4,"totalPanels":4,"panelsPerPage":1}');
  });

  it('§18/§19 违反硬约束（形式跑偏）→ Validator 拒绝 → repair 携带「用户明确选择…硬约束」前言 → 仍违反 → 报错（不静默接受）', async () => {
    // 两次尝试都跑偏：第 3 个方案变成九宫格（grid_4 / grid_4 / grid_9）
    const violating = [...constrainedConcepts('grid_4', 4).slice(0, 2), constrainedConcepts('grid_9', 9)[0]!];
    replyWith({ concepts: violating });
    replyWith({ concepts: violating });
    const outcome = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed', templateId: 'grid_4' },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toContain('方案');
    expect(runMock).toHaveBeenCalledTimes(2);
    // 第二次请求的 user content：§19 硬约束修复前言 + 具体问题清单
    const repairContent = String(runMock.mock.calls[1]![0]!.messages[0]!.content);
    expect(repairContent).toContain('用户明确选择「四宫格」');
    expect(repairContent).toContain('硬约束');
    expect(repairContent).toContain('不允许修改');
    expect(repairContent).toContain('layout.arrangement');
    // 修复前言在问题清单之前（先声明约束不可改，再列具体违规）
    expect(repairContent.indexOf('用户明确选择')).toBeLessThan(repairContent.indexOf('具体问题'));
  });

  it('beats 数量与约束不符（形式对但拍数错）→ 同样硬校验拒绝', async () => {
    const wrong = constrainedConcepts('grid_4', 4);
    (wrong[0]!.storyboardBeats as unknown[]).pop(); // 3 拍 ≠ 4 格
    replyWith({ concepts: wrong });
    replyWith({ concepts: wrong });
    const outcome = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed', templateId: 'grid_4' },
    });
    expect(outcome.ok).toBe(false);
    const repairContent = String(runMock.mock.calls[1]![0]!.messages[0]!.content);
    expect(repairContent).toContain('storyboardBeats 长度=3');
  });

  it('修复轮回到正确几何 → 成功（repair 真的能救回，不是必败）', async () => {
    replyWith({ concepts: [...constrainedConcepts('grid_4', 4).slice(0, 2), constrainedConcepts('grid_9', 9)[0]!] });
    replyWith({ concepts: constrainedConcepts('grid_4', 4) });
    const outcome = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed', templateId: 'grid_4' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.concepts.every(concept => concept.layout.arrangement === 'grid_4')).toBe(true);
  });
});

describe('V4.2.8 §92 auto 约束（AI 自由 + 故事多样性为核心）', () => {
  it('auto：无硬约束块；user content 携带 {"mode":"auto"} 与自由选择说明', async () => {
    replyWith({ concepts: threeConcepts(() => ({})) });
    const outcome = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'auto' },
    });
    expect(outcome.ok).toBe(true);
    const systemPrompt = String(lastRequest().system_prompt);
    expect(systemPrompt).not.toContain('用户指定的漫画形式（硬约束');
    const autoRequest = lastRequest() as { messages?: Array<{ content?: string }> };
    const userContent = String(autoRequest.messages![0]!.content);
    expect(userContent).toContain('漫画形式约束：{"mode":"auto"}');
    expect(userContent).toContain('故事差异才是核心');
  });

  it('auto 下三方案形式各异（grid_4 / vertical_3 / single）合法通过（不做形式校验）', async () => {
    replyWith({ concepts: threeConcepts(index => ([
      { layout: { panelCount: 4, arrangement: 'grid_4' } },
      { layout: { panelCount: 3, arrangement: 'vertical_3' } },
      { layout: { panelCount: 1, arrangement: 'single' } },
    ])[index]) });
    const outcome = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'auto' },
    });
    expect(outcome.ok).toBe(true);
  });

  it('非法约束归一为 auto：fixed 缺模板 / 模板不存在 → 回落 AI 自由（不报错）', async () => {
    replyWith({ concepts: threeConcepts(() => ({})) });
    replyWith({ concepts: threeConcepts(() => ({})) });
    const missing = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed' },
    });
    expect(missing.ok).toBe(true);
    const unknown = await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed', templateId: 'custom' as never },
    });
    expect(unknown.ok).toBe(true);
    expect(String(lastRequest().system_prompt)).not.toContain('用户指定的漫画形式（硬约束');
  });
});

describe('V4.2.8 §57~§59 同形式下的故事多样性', () => {
  it('fixed 硬约束块要求三方案故事真正不同（不是同一笑话换皮）', async () => {
    replyWith({ concepts: constrainedConcepts('grid_4', 4) });
    await recommendComicConcepts({
      requirement: 'x',
      presentationConstraint: { mode: 'fixed', templateId: 'grid_4' },
    });
    const systemPrompt = String(lastRequest().system_prompt);
    expect(systemPrompt).toContain('故事必须真正不同');
    expect(systemPrompt).toContain('不得把同一个笑话换几个字重复三遍');
  });

  it('auto 同样强调故事差异是核心（system prompt 保持「必须本质不同」铁律）', async () => {
    replyWith({ concepts: threeConcepts(() => ({})) });
    await recommendComicConcepts({ requirement: 'x', presentationConstraint: { mode: 'auto' } });
    expect(String(lastRequest().system_prompt)).toContain('必须本质不同');
  });
});

describe('V4.2.8 §52 Concept → Character Slots 确定性转移', () => {
  function conceptWithCharacters(characters: Array<{ name: string; role?: string }>) {
    return {
      id: 'concept-a',
      name: '小鸭冷笑话',
      storyTitle: '《小鸭为什么不怕冷？》',
      oneLineStory: '一句话',
      fullStory: '完整故事',
      punchline: '自带羽绒服',
      reason: '', comicForm: '四格漫画',
      visualStyle: '简笔', storyPattern: '', dialogueStyle: '',
      layout: { panelCount: 4, arrangement: 'grid_4' },
      characters,
      storyboardBeats: [], tone: '',
    } as never;
  }

  it('concept 点名角色缺失时按顺序追加槽位（concept-N，非必选），LLM 槽位保留', async () => {
    replyWith({
      name: '小鸭冷笑话',
      comicForm: '四格漫画',
      characterSlots: [{ slotId: 'duck', name: '小鸭', required: true }],
    });
    const outcome = await draftComicSkill({
      requirement: 'x',
      concept: conceptWithCharacters([{ name: '小鸭', role: '主角' }, { name: '朋友', role: '配角' }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.skill.characterSlots.map(slot => [slot.name, slot.required])).toEqual([
      ['小鸭', true],   // LLM 已生成，保留
      ['朋友', false],  // concept 补充，非必选
    ]);
    expect(outcome.skill.characterSlots[1]!.slotId).toMatch(/^concept-\d+$/);
  });

  it('LLM 一个必选槽位都没给时，首个追加槽位兜底 required（过「至少一个必选」校验）', async () => {
    replyWith({
      name: '小鸭冷笑话',
      comicForm: '四格漫画',
      characterSlots: [{ slotId: 's1', name: '路人甲', required: false }],
    });
    const outcome = await draftComicSkill({
      requirement: 'x',
      concept: conceptWithCharacters([{ name: '小鸭', role: '主角' }]),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const hero = outcome.skill.characterSlots.find(slot => slot.name === '小鸭')!;
    expect(hero.required).toBe(true);
  });
});
