import { describe, it, expect, vi } from 'vitest';

// 解析层单测：不触达真实 Tauri IPC / Provider 配置
vi.mock('../api', () => ({
  api: { runAgentRequest: vi.fn() },
}));
vi.mock('../../features/aiProviders/store', () => ({
  resolveByokConfigForUse: vi.fn(),
}));
vi.mock('../../features/aiProviders/providerError', () => ({
  buildProviderError: vi.fn(() => ({})),
  providerErrorCompact: vi.fn(() => ''),
}));

import { parsePlannerReply } from '../batchPlanner';

const VALID_PLANS_JSON = JSON.stringify({
  plans: [
    {
      title: '红黑重甲 · 长枪 · 古城墙',
      summary: '年轻战国女将身穿红黑札甲，手持长枪，立于烽火古城墙前，写实电影光影。',
      tags: ['战国女将', '红黑甲胄', '长枪', '古城墙', '电影感'],
      description: '完整方案描述1',
      positive_prompt: 'Warring States female general, red-black lamellar armor, spear, ancient city wall, cinematic realism',
      negative_prompt: '模糊，水印，多余手指',
    },
    {
      title: '青铜甲胄 · 长剑 · 黄昏军营',
      summary: '青铜甲胄女将持长剑立于黄昏军营，暖色调。',
      tags: ['青铜甲胄', '长剑', '军营', '黄昏'],
      description: '完整方案描述2',
      positive_prompt: 'bronze armor female warrior, long sword, dusk military camp',
      negative_prompt: '无',
    },
  ],
});

describe('parsePlannerReply（批量方案结构化 JSON 解析）', () => {
  it('标准 JSON：完整解析所有字段', () => {
    const parsed = parsePlannerReply(VALID_PLANS_JSON);
    expect(parsed).not.toBeNull();
    expect(parsed!.plans).toHaveLength(2);
    expect(parsed!.plans[0].title).toBe('红黑重甲 · 长枪 · 古城墙');
    expect(parsed!.plans[0].tags).toHaveLength(5);
    expect(parsed!.plans[0].positivePrompt).toContain('red-black lamellar');
    expect(parsed!.plans[0].negativePrompt).toBe('模糊，水印，多余手指');
  });

  it('容忍 Markdown 代码栅栏与前后多余文本', () => {
    const reply = `以下是规划结果：\n\`\`\`json\n${VALID_PLANS_JSON}\n\`\`\`\n希望对你有帮助。`;
    const parsed = parsePlannerReply(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.plans).toHaveLength(2);
  });

  it('剥离 <think> 推理段', () => {
    const reply = `<think>用户要3个方案，我要差异化…</think>\n${VALID_PLANS_JSON}`;
    expect(parsePlannerReply(reply)).not.toBeNull();
  });

  it('negative_prompt 的「无」归一化为空字符串', () => {
    const parsed = parsePlannerReply(VALID_PLANS_JSON);
    expect(parsed!.plans[1].negativePrompt).toBe('');
  });

  it('tags：去重、过滤非字符串、截断到 6 个', () => {
    const json = JSON.stringify({
      plans: [{
        title: 'T',
        summary: 'S',
        tags: ['战国', '战国', 42, null, '甲胄', '长枪', '城墙', '黄昏', '骑马', '远景'],
        description: 'D',
        positive_prompt: 'P',
        negative_prompt: '',
      }],
    });
    const parsed = parsePlannerReply(json);
    expect(parsed!.plans[0].tags).toEqual(['战国', '甲胄', '长枪', '城墙', '黄昏', '骑马']);
  });

  it('缺正向提示词的条目被丢弃，其余条目保留', () => {
    const json = JSON.stringify({
      plans: [
        { title: '坏条目', summary: 'S', tags: [], description: 'D', negative_prompt: 'X' },
        { title: '好条目', summary: 'S', tags: [], description: 'D', positive_prompt: 'P', negative_prompt: '' },
      ],
    });
    const parsed = parsePlannerReply(json);
    expect(parsed!.plans).toHaveLength(1);
    expect(parsed!.plans[0].title).toBe('好条目');
  });

  it('非 plans 结构 / 纯文本 / 空 plans → null（调用方报错，不接受半截结果）', () => {
    expect(parsePlannerReply('这不是 JSON')).toBeNull();
    expect(parsePlannerReply('{"result": 1}')).toBeNull();
    expect(parsePlannerReply('{"plans": []}')).toBeNull();
    expect(parsePlannerReply('')).toBeNull();
  });

  it('JSON 字符串内含花括号时不破坏配平截取', () => {
    const json = JSON.stringify({
      plans: [{
        title: 'T',
        summary: '包含 } 与 { 的摘要 {x}',
        tags: [],
        description: 'D {nested "quote"}',
        positive_prompt: 'P with } brace',
        negative_prompt: '',
      }],
    });
    const parsed = parsePlannerReply(`前缀说明\n${json}\n后缀`);
    expect(parsed!.plans[0].summary).toContain('{x}');
  });
});
