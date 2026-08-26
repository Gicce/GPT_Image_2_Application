import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  parseVisionOptimizerJson,
  parseVisionOptimizerReply,
  buildVisionRecreationUserContent,
} from '../promptOptimizer';
import { buildRecreationPlan } from '../../features/vision/recreationPlan';
import type { VisionAnalysis } from '../../types';

const STORE_PATH_OPTIMIZER = fileURLToPath(new URL('../promptOptimizer.ts', import.meta.url));

function fixtureAnalysis(): VisionAnalysis {
  return {
    summary: '一名男性篮球运动员在室内球馆上篮',
    subjects: [
      {
        label: '成年男性篮球运动员',
        appearance: ['红色球衣'],
        clothing: ['红色 23 号球衣'],
        pose: '腾空上篮',
        action: '单手扣篮',
        position: { x: 0.3, y: 0.2, width: 0.4, height: 0.7 },
        relations: [],
      },
    ],
    objects: [],
    scene: { environment: '室内篮球馆', location: '', time_of_day: '白天', weather: '', background: '观众席虚化', foreground: '' },
    composition: { subject_placement: '主体居中偏左', symmetry: '', negative_space: '', crop: '全身', depth_layers: '' },
    camera: { shot_type: '中远景', perspective: '', angle: '低角度仰拍', depth_of_field: '浅景深', lens_characteristics: '' },
    lighting: { source: '顶部场馆灯', direction: '顶光', softness: '硬光', key_fill_rim: '', contrast: '', time_of_day: '', exposure: '' },
    colors: { dominant_palette: ['红色'], temperature: '暖色', saturation: '', contrast: '' },
    style: { category: '运动摄影', medium: '照片', texture: '', rendering: '写实', photographic_characteristics: '' },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  } as unknown as VisionAnalysis;
}

describe('parseVisionOptimizerJson（JSON 主协议：summary 缺失不再导致失败）', () => {
  it('解析标准 JSON：positive / negative / summary', () => {
    const reply = '{"positive_prompt":"一名年轻亚洲女性篮球运动员上篮……","negative_prompt":"低画质，模糊","summary":"已将人物替换为年轻亚洲女性篮球运动员，保留上篮动作。"}';
    const parsed = parseVisionOptimizerJson(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toContain('年轻亚洲女性');
    expect(parsed!.negative).toContain('低画质');
    expect(parsed!.summary).toContain('保留');
  });

  it('容忍代码栅栏与前后说明文字', () => {
    const reply = '好的，以下是优化结果：\n```json\n{"positive_prompt":"最终 Prompt","negative_prompt":"无","summary":"摘要"}\n```';
    const parsed = parseVisionOptimizerJson(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe('最终 Prompt');
    expect(parsed!.negative).toBeUndefined();
    expect(parsed!.summary).toBe('摘要');
  });

  it('剥离 <think> 推理段', () => {
    const reply = '<think>分析锁定维度…</think>{"positive_prompt":"P","negative_prompt":"","summary":"S"}';
    const parsed = parseVisionOptimizerJson(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe('P');
  });

  it('缺少 summary 仍解析成功（历史缺陷：summary 必填导致整次优化报「未返回有效结果」）', () => {
    const parsed = parseVisionOptimizerJson('{"positive_prompt":"P","negative_prompt":"N"}');
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toBe('P');
    expect(parsed!.summary).toBeUndefined();
  });

  it('缺少 positive_prompt / 完全非 JSON / 空串 → null（绝不返回半截结果）', () => {
    expect(parseVisionOptimizerJson('{"negative_prompt":"N","summary":"S"}')).toBeNull();
    expect(parseVisionOptimizerJson('不是 JSON')).toBeNull();
    expect(parseVisionOptimizerJson('')).toBeNull();
  });
});

describe('parseVisionOptimizerReply（非标准返回的多级 fallback 解析）', () => {
  it('JSON 优先：标准 JSON 直接通过（V4.1 含维度意图字段）', () => {
    const parsed = parseVisionOptimizerReply('{"positive_prompt":"P","negative_prompt":"N","summary":"S"}');
    expect(parsed).toEqual({
      prompt: 'P',
      negative: 'N',
      summary: 'S',
      changedDimensions: [],
      dimensionValues: {},
    });
  });

  it('文本标签协议：OPTIMIZED / NEGATIVE / SUMMARY 标签可解析', () => {
    const reply = 'OPTIMIZED:\n一名蓝色小龙在雪山前……\nNEGATIVE:\n低画质，模糊\nSUMMARY:\n已替换主体并保留背景';
    const parsed = parseVisionOptimizerReply(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toContain('蓝色小龙');
    expect(parsed!.negative).toContain('低画质');
    expect(parsed!.summary).toContain('保留背景');
  });

  it('纯文本（无任何标签/JSON）→ 整段视为优化结果（不丢弃有效输出）', () => {
    const reply = '一名身穿白色球衣的运动员在室内球馆上篮，保持原始构图与光线。';
    const parsed = parseVisionOptimizerReply(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toContain('白色球衣');
  });

  it('代码栅栏包裹的纯文本 → 剥离栅栏后解析', () => {
    const reply = '```\n最终生图 Prompt：身穿白色球衣的运动员……\n```';
    const parsed = parseVisionOptimizerReply(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.prompt).toContain('白色球衣');
  });

  it('空内容 → null（调用方据此判定「模型未返回可用结果」）', () => {
    expect(parseVisionOptimizerReply('')).toBeNull();
    expect(parseVisionOptimizerReply('   \n  ')).toBeNull();
    expect(parseVisionOptimizerReply('<think>只有思考没有输出</think>')).toBeNull();
  });
});

describe('buildVisionRecreationUserContent（用户手动锁定真正进入优化器输入）', () => {
  it('包含原始 Prompt、结构化方案、维度锁定来源与大白话调整要求', () => {
    let plan = buildRecreationPlan(fixtureAnalysis());
    // 用户手动锁定 color（V4.1：只有 user_override 是硬约束）
    plan = { ...plan, fields: plan.fields.map(f => (f.key === 'color' ? { ...f, locked: true, lockSource: 'user_override' as const } : f)) };
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: '一名男性篮球运动员在室内球馆上篮……',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '把角色换成蓝色小龙，并让整体更梦幻',
      targetImageModelInfo: 'gpt-image-2（GPT Image 系，自然语言长句偏好）',
      originalNegativePrompt: '低画质',
    });
    expect(content).toContain('【结构化复刻方案】');
    expect(content).toContain('一名男性篮球运动员在室内球馆上篮……');
    expect(content).toContain('把角色换成蓝色小龙，并让整体更梦幻');
    expect(content).toContain('【用户手动锁定项');
    expect(content).toContain('色彩');
    expect(content).toContain('用户手动锁定（最高优先级：必须保持不变）');
    // Dimension Lock：未启用修改的默认维度 = 模板锁定（不再交给 AI 自行判断）
    expect(content).toContain('模板锁定（未启用修改');
    expect(content).toContain('gpt-image-2');
    expect(content).toContain('changed_dimensions');
  });

  it('用户手动锁定切换后内容随之变化（scene 手动锁定 → 解除 → 移出锁定项）', () => {
    const lockedLine = (content: string) =>
      (content.match(/【用户手动锁定项[^\n]*\n([^\n]*)/) ?? [])[1] ?? '';

    const plan = buildRecreationPlan(fixtureAnalysis());
    const manualPlan = {
      ...plan,
      fields: plan.fields.map(f => (f.key === 'scene' ? { ...f, locked: true, lockSource: 'user_override' as const } : f)),
    };
    const contentBefore = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: manualPlan,
      userAdjustmentInstruction: '换背景',
    });
    expect(lockedLine(contentBefore)).toContain('背景 / 场景');
    expect(contentBefore).toContain('背景 / 场景［用户手动锁定（最高优先级：必须保持不变）］');

    const unlocked = {
      ...plan,
      fields: plan.fields.map(f => (f.key === 'scene' ? { ...f, locked: false, lockSource: 'user_override' as const } : f)),
    };
    const contentAfter = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: unlocked,
      userAdjustmentInstruction: '换背景',
    });
    expect(lockedLine(contentAfter)).not.toContain('背景 / 场景');
    expect(contentAfter).toContain('背景 / 场景［用户手动开放（允许按调整要求修改）］');
  });

  it('无用户手动锁定时锁定项为（无）：默认保留交给 AI 按意图判断', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '换背景',
    });
    const lockedLine = (content.match(/【用户手动锁定项[^\n]*\n([^\n]*)/) ?? [])[1] ?? '';
    expect(lockedLine).toBe('（无）');
  });
});

describe('clothing 维度协议扩展（V4.1：人物 / 服装独立判定）', () => {
  it('changed_dimensions 含 clothing 时正常解析为结构化意图', () => {
    const reply = '{"positive_prompt":"一名黑发男性身穿白色西装站在球馆……","negative_prompt":"","summary":"已替换人物并按描述更换服装","changed_dimensions":["subject","clothing"],"dimension_values":{"subject":"黑发男性","clothing":"白色西装"}}';
    const parsed = parseVisionOptimizerJson(reply);
    expect(parsed).not.toBeNull();
    expect(parsed!.changedDimensions).toEqual(['subject', 'clothing']);
    expect(parsed!.dimensionValues.clothing).toBe('白色西装');
  });

  it('只改服装：changed_dimensions 仅 clothing（subject 不被连带）', () => {
    const reply = '{"positive_prompt":"人物保持不变，身穿红色晚礼服……","negative_prompt":"","summary":"只更换了服装","changed_dimensions":["clothing"],"dimension_values":{"clothing":"红色晚礼服"}}';
    const parsed = parseVisionOptimizerJson(reply);
    expect(parsed!.changedDimensions).toEqual(['clothing']);
  });

  it('系统提示词包含 clothing 维度与人物/服装区分规则（协议单一来源）', () => {
    const source = readFileSync(STORE_PATH_OPTIMIZER, 'utf-8');
    expect(source).toContain("'subject', 'clothing', 'pose'");
    expect(source).toContain('「人物 / 主体」（subject）与「服装 / 造型」（clothing）是两个独立维度');
    expect(source).toContain('服装处理');
  });

  it('结构化方案行包含服装 / 造型维度（buildVisionRecreationUserContent 自动带出）', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '人物不变，换成黑色连衣裙',
    });
    expect(content).toContain('服装 / 造型');
    expect(content).toContain('红色 23 号球衣');
  });
});

describe('forcedDimensions（V4.1：Chip 启用维度必须真实修改）', () => {
  it('启用人物 / 动作 / 背景 → 三个方案行标为「用户显式要求修改」', () => {
    const plan = buildRecreationPlan(fixtureAnalysis());
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: '把人物换成参考人物，动作和背景也要变',
      forcedDimensions: ['subject', 'pose', 'scene'],
    });
    expect(content).toContain('人物 / 主体［用户显式要求修改（必须真实修改该维度并列入 changed_dimensions');
    expect(content).toContain('动作［用户显式要求修改（必须真实修改该维度并列入 changed_dimensions');
    expect(content).toContain('背景 / 场景［用户显式要求修改（必须真实修改该维度并列入 changed_dimensions');
    expect(content).toContain('绝不保持原值');
    // Dimension Lock：未启用维度 = 模板锁定（禁止修改 / 禁止列入 changed_dimensions / 禁止重新描述）
    expect(content).toContain('模板锁定（未启用修改');
  });

  it('user_override 锁定优先：手动锁定维度不受 forcedDimensions 影响', () => {
    const plan = {
      ...buildRecreationPlan(fixtureAnalysis()),
      fields: buildRecreationPlan(fixtureAnalysis()).fields.map(
        f => (f.key === 'pose' ? { ...f, locked: true, lockSource: 'user_override' as const } : f),
      ),
    };
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: plan,
      userAdjustmentInstruction: 'x',
      forcedDimensions: ['pose'],
    });
    expect(content).toContain('动作［用户手动锁定（最高优先级：必须保持不变）］');
    expect(content).not.toContain('动作［用户显式要求修改');
  });

  it('系统提示词含规则 2a（显式启用维度不受「禁止大面积放开」约束）', () => {
    const source = readFileSync(STORE_PATH_OPTIMIZER, 'utf-8');
    expect(source).toContain('2a.');
    expect(source).toContain('用户显式要求修改');
    expect(source).toContain('不适用于这些显式开启的维度');
  });
});
