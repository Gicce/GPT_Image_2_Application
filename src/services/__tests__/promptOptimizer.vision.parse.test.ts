import { describe, it, expect } from 'vitest';
import {
  parseVisionOptimizerJson,
  parseVisionOptimizerReply,
  buildVisionRecreationUserContent,
} from '../promptOptimizer';
import { buildRecreationPlan } from '../../features/vision/recreationPlan';
import type { VisionAnalysis } from '../../types';

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
  it('JSON 优先：标准 JSON 直接通过', () => {
    const parsed = parseVisionOptimizerReply('{"positive_prompt":"P","negative_prompt":"N","summary":"S"}');
    expect(parsed).toEqual({ prompt: 'P', negative: 'N', summary: 'S' });
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

describe('buildVisionRecreationUserContent（锁定项真正进入优化器输入）', () => {
  it('包含原始 Prompt、结构化方案、锁定项与大白话调整要求', () => {
    let plan = buildRecreationPlan(fixtureAnalysis());
    plan = { ...plan, fields: plan.fields.map(f => (f.key === 'color' ? { ...f, locked: false } : f)) };
    const content = buildVisionRecreationUserContent({
      originalRecreationPrompt: '一名男性篮球运动员在室内球馆上篮……',
      structuredRecreationPlan: plan,
      lockedFields: plan.fields.filter(f => f.locked).map(f => f.key),
      userAdjustmentInstruction: '把角色换成蓝色小龙，并让整体更梦幻',
      targetImageModelInfo: 'gpt-image-2（GPT Image 系，自然语言长句偏好）',
      originalNegativePrompt: '低画质',
    });
    expect(content).toContain('【结构化复刻方案】');
    expect(content).toContain('一名男性篮球运动员在室内球馆上篮……');
    expect(content).toContain('把角色换成蓝色小龙，并让整体更梦幻');
    expect(content).toContain('【锁定项');
    expect(content).toContain('动作');
    expect(content).toContain('锁定（必须保持不变）');
    expect(content).toContain('可修改（允许按调整要求修改）');
    expect(content).toContain('gpt-image-2');
  });

  it('锁定项切换后内容随之变化（scene 解锁 → 不再列入锁定项）', () => {
    const lockedLine = (content: string) =>
      (content.match(/【锁定项[^\n]*\n([^\n]*)/) ?? [])[1] ?? '';

    const plan = buildRecreationPlan(fixtureAnalysis());
    const lockedBefore = plan.fields.filter(f => f.locked).map(f => f.key);
    const contentBefore = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: plan,
      lockedFields: lockedBefore,
      userAdjustmentInstruction: '换背景',
    });
    expect(lockedLine(contentBefore)).toContain('背景 / 场景');
    expect(contentBefore).toContain('背景 / 场景［锁定（必须保持不变）］');

    const unlocked = { ...plan, fields: plan.fields.map(f => (f.key === 'scene' ? { ...f, locked: false } : f)) };
    const contentAfter = buildVisionRecreationUserContent({
      originalRecreationPrompt: 'p',
      structuredRecreationPlan: unlocked,
      lockedFields: unlocked.fields.filter(f => f.locked).map(f => f.key),
      userAdjustmentInstruction: '换背景',
    });
    expect(lockedLine(contentAfter)).not.toContain('背景 / 场景');
    expect(contentAfter).toContain('背景 / 场景［可修改（允许按调整要求修改）］');
  });
});
