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

import {
  buildVisionRecreationUserContent,
  parseOptimizerItems,
  parseOptimizerJson,
  parseOptimizerReply,
  parseVisionOptimizerJson,
  parseVisionOptimizerReply,
} from '../promptOptimizer';


describe('parseOptimizerItems（多 Prompt 批量结构化输出解析）', () => {
  it('标准格式：编号 + 标题 | 提示词 + NEGATIVE', () => {
    const reply = [
      'OPTIMIZED_ITEMS:',
      '1. 上海夜景 | 上海陆家嘴夜景，东方明珠与环球金融中心灯光璀璨，黄浦江倒影，电影感广角',
      '2. 北京夜景 | 北京国贸CBD夜景，中国尊与央视大楼轮廓灯光，车流光轨，城市霓虹',
      '3. 广州夜景 | 广州珠江新城夜景，广州塔灯光秀与珠江水面倒影，繁华都市氛围',
      'NEGATIVE:',
      '模糊，低分辨率',
    ].join('\n');
    const parsed = parseOptimizerItems(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(3);
    expect(parsed!.items[0].title).toBe('上海夜景');
    expect(parsed!.items[0].prompt).toContain('上海陆家嘴');
    expect(parsed!.items[2].prompt).toContain('广州塔');
    expect(parsed!.negative).toBe('模糊，低分辨率');
  });

  it('缺少 | 分隔时整行作为提示词，标题截断', () => {
    const reply = [
      'OPTIMIZED_ITEMS:',
      '1. 上海陆家嘴夜景东方明珠黄浦江倒影电影感',
      '2. 北京国贸CBD夜景中国尊车流光轨',
      'NEGATIVE:',
      '无',
    ].join('\n');
    const parsed = parseOptimizerItems(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(2);
    expect(parsed!.items[0].prompt).toContain('上海陆家嘴');
    expect(parsed!.negative).toBeUndefined();
  });

  it('模型输出单条合并 Prompt（未按列表格式）→ 拒绝（返回 null，调用方报错重试）', () => {
    const reply = 'OPTIMIZED:\n一张图展示上海北京广州三个城市夜景，三联画构图\nNEGATIVE:\n无';
    expect(parseOptimizerItems(reply)).toBeNull();
  });

  it('带 markdown 代码块包裹也能解析', () => {
    const reply = [
      '```',
      'OPTIMIZED_ITEMS:',
      '1. A | 提示词A',
      '2. B | 提示词B',
      '```',
    ].join('\n');
    const parsed = parseOptimizerItems(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(2);
  });

  it('空回复 / 只有一条 → null', () => {
    expect(parseOptimizerItems('')).toBeNull();
    expect(parseOptimizerItems('OPTIMIZED_ITEMS:\n1. 只有一条')).toBeNull();
  });

  it('模型变体标记 _ITEMS: + 中文负面标签（GLM-5.2 实际输出形态）也能结构化解析', () => {
    const reply = [
      '_ITEMS:',
      '1. 战国美人 · 城郭 | 战国时期美人，曲裾深衣立于城郭之下，广袖翩然，工笔重彩',
      '2. 战国美人 · 宫殿 | 战国时期美人，宫殿回廊之间，玉簪束发，烛光映绢本',
      '3. 战国美人 · 山野 | 战国时期美人，山野春色之间，荆钗布裙，水墨晕染',
      '建议负面提示词：',
      '现代服装、现代物品、现代发型',
    ].join('\n');
    const parsed = parseOptimizerItems(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.items).toHaveLength(3);
    expect(parsed!.items[0].prompt).toContain('曲裾深衣');
    expect(parsed!.negative).toBe('现代服装、现代物品、现代发型');
  });

  it('__ITEMS__ / ITEMS: 变体标记同样接受', () => {
    expect(parseOptimizerItems('__ITEMS__\n1. A | 甲\n2. B | 乙')!.items).toHaveLength(2);
    expect(parseOptimizerItems('ITEMS:\n1. A | 甲\n2. B | 乙')!.items).toHaveLength(2);
  });

  it('3 条子 Prompt 解析后就是 3 条（无 base + 变体膨胀）', () => {
    const reply = 'OPTIMIZED_ITEMS:\n1. A | 甲\n2. B | 乙\n3. C | 丙\nNEGATIVE:\n无';
    expect(parseOptimizerItems(reply)!.items).toHaveLength(3);
  });
});

describe('parseOptimizerReply（单条优化输出解析）', () => {
  it('标准 OPTIMIZED / NEGATIVE 两段式', () => {
    const parsed = parseOptimizerReply('OPTIMIZED:\n战国美人，工笔重彩\nNEGATIVE:\n现代服装');
    expect(parsed).toEqual({ prompt: '战国美人，工笔重彩', negative: '现代服装' });
  });

  it('中文负面标签变体：建议负面提示词：', () => {
    const parsed = parseOptimizerReply('OPTIMIZED:\n战国美人，工笔重彩\n建议负面提示词：\n现代服装、现代物品');
    expect(parsed!.prompt).toBe('战国美人，工笔重彩');
    expect(parsed!.negative).toBe('现代服装、现代物品');
  });

  it('模型未按格式输出 → 整段视为优化结果（不丢弃有效输出）', () => {
    const parsed = parseOptimizerReply('战国美人，工笔重彩，细腻绢本质感');
    expect(parsed).toEqual({ prompt: '战国美人，工笔重彩，细腻绢本质感', negative: undefined });
  });

  it('负面值为"无"时 → negative 为 undefined', () => {
    const parsed = parseOptimizerReply('OPTIMIZED:\n战国美人\nNEGATIVE:\n无');
    expect(parsed!.negative).toBeUndefined();
  });

  it('空回复 → null', () => {
    expect(parseOptimizerReply('')).toBeNull();
    expect(parseOptimizerReply('NEGATIVE:\n无')).toBeNull();
  });
});

describe('parseOptimizerJson（结构化 JSON 输出解析）', () => {
  it('标准 JSON：positive_prompt + negative_prompt', () => {
    const parsed = parseOptimizerJson('{"positive_prompt":"战国美人，工笔重彩","negative_prompt":"现代服装，多余手指"}');
    expect(parsed).toEqual({ prompt: '战国美人，工笔重彩', negative: '现代服装，多余手指' });
  });

  it('markdown 代码栅栏包裹（```json ... ```）也能解析', () => {
    const reply = '```json\n{"positive_prompt":"未来城市夜景","negative_prompt":"模糊，低分辨率"}\n```';
    const parsed = parseOptimizerJson(reply);
    expect(parsed).toEqual({ prompt: '未来城市夜景', negative: '模糊，低分辨率' });
  });

  it('JSON 前后带说明文字：截取配平的 {} 片段解析', () => {
    const reply = '好的，以下是优化结果：\n{"positive_prompt":"赛博朋克机器人","negative_prompt":"水印，文字"}\n希望对你有帮助。';
    const parsed = parseOptimizerJson(reply);
    expect(parsed).toEqual({ prompt: '赛博朋克机器人', negative: '水印，文字' });
  });

  it('缺失 negative_prompt 字段 → negative 为 undefined（不崩溃）', () => {
    const parsed = parseOptimizerJson('{"positive_prompt":"上海夜景"}');
    expect(parsed).toEqual({ prompt: '上海夜景', negative: undefined });
  });

  it('negative_prompt 为 "无" / "NONE" → 归一化为 undefined', () => {
    expect(parseOptimizerJson('{"positive_prompt":"a","negative_prompt":"无"}')).toEqual({ prompt: 'a', negative: undefined });
    expect(parseOptimizerJson('{"positive_prompt":"a","negative_prompt":"NONE"}')).toEqual({ prompt: 'a', negative: undefined });
  });

  it('字段值含转义引号与嵌套大括号也能配平', () => {
    const parsed = parseOptimizerJson('{"positive_prompt":"包含 \\"引号\\" 和 {花括号} 的提示词","negative_prompt":"x"}');
    expect(parsed!.prompt).toContain('引号');
    expect(parsed!.negative).toBe('x');
  });

  it('positive_prompt 缺失或非字符串 → null（不返回半截结果）', () => {
    expect(parseOptimizerJson('{"negative_prompt":"只有负面"}')).toBeNull();
    expect(parseOptimizerJson('{"positive_prompt":"","negative_prompt":"x"}')).toBeNull();
    expect(parseOptimizerJson('{"positive_prompt":123}')).toBeNull();
  });

  it('非法 JSON / 无大括号 → null', () => {
    expect(parseOptimizerJson('')).toBeNull();
    expect(parseOptimizerJson('纯文本没有大括号')).toBeNull();
    expect(parseOptimizerJson('{positive_prompt: 未加引号的非法 JSON}')).toBeNull();
  });

  it('<think> 推理段混入时先剥离再解析', () => {
    const reply = '<think>用户想要夜景，我要输出 JSON</think>\n{"positive_prompt":"雨夜街道","negative_prompt":"白天的画面"}';
    const parsed = parseOptimizerJson(reply);
    expect(parsed).toEqual({ prompt: '雨夜街道', negative: '白天的画面' });
  });
});

describe('parseVisionOptimizerJson（结构化维度意图协议）', () => {
  it('完整协议：positive / negative / summary / changed_dimensions / dimension_values', () => {
    const reply = '{"positive_prompt":"……比心……","negative_prompt":"低画质","summary":"已把动作改为比心","changed_dimensions":["pose"],"dimension_values":{"pose":"双手在胸前组成比心手势"}}';
    const parsed = parseVisionOptimizerJson(reply)!;
    expect(parsed.prompt).toContain('比心');
    expect(parsed.changedDimensions).toEqual(['pose']);
    expect(parsed.dimensionValues.pose).toBe('双手在胸前组成比心手势');
  });

  it('多维修改（背景 + 动作 + 色调）按序保留', () => {
    const reply = '{"positive_prompt":"p","changed_dimensions":["pose","scene","color"],"dimension_values":{"pose":"比心","scene":"海边夕阳","color":"暖色调"}}';
    const parsed = parseVisionOptimizerJson(reply)!;
    expect(parsed.changedDimensions).toEqual(['pose', 'scene', 'color']);
  });

  it('未知维度 key 与非字符串值被过滤（不产生幽灵维度）', () => {
    const reply = '{"positive_prompt":"p","changed_dimensions":["pose","mood",42],"dimension_values":{"pose":"比心","mood":"忽略我","camera":123}}';
    const parsed = parseVisionOptimizerJson(reply)!;
    expect(parsed.changedDimensions).toEqual(['pose']);
    expect(parsed.dimensionValues).toEqual({ pose: '比心' });
  });

  it('旧协议（无 changed_dimensions）→ 空数组 / 空 values（向后兼容）', () => {
    const parsed = parseVisionOptimizerJson('{"positive_prompt":"p","summary":"s"}')!;
    expect(parsed.changedDimensions).toEqual([]);
    expect(parsed.dimensionValues).toEqual({});
  });

  it('文本标签协议（非 JSON 回退）→ 意图字段为空但不失败', () => {
    const parsed = parseVisionOptimizerReply('OPTIMIZED:\n重建后的 Prompt\n\nSUMMARY: 一句话摘要')!;
    expect(parsed.prompt).toContain('重建后的 Prompt');
    expect(parsed.changedDimensions).toEqual([]);
  });

  it('用户手动锁定维度必须进入优化器提示词（buildVisionRecreationUserContent）', () => {
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: '原始 Prompt',
      structuredRecreationPlan: {
        summary: '概述',
        fields: [
          { key: 'pose', label: '动作', value: '腾空上篮', locked: true, lockSource: 'user_override' },
          { key: 'scene', label: '背景 / 场景', value: '室内球馆', locked: false, lockSource: 'user_override' },
          { key: 'style', label: '风格', value: '写实', locked: true, lockSource: 'default' },
        ],
      },
      userAdjustmentInstruction: '让人物做一个比心动作',
    });
    expect(content).toContain('用户手动锁定（最高优先级：必须保持不变）');
    expect(content).toContain('用户手动开放（允许按调整要求修改）');
    expect(content).toContain('模板锁定（未启用修改');
    expect(content).toContain('让人物做一个比心动作');
    expect(content).toContain('changed_dimensions');
  });
});
