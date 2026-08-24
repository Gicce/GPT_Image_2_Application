import { describe, expect, it } from 'vitest';
import { buildPromptChangeSummary } from '../promptChangeSummary';
import { buildRecreationPlan, type RecreationState } from '../recreationPlan';
import type { VisionAnalysis } from '../../../types';

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

function stateWithInstruction(instruction: string): RecreationState {
  const plan = buildRecreationPlan(fixtureAnalysis());
  return {
    plan,
    originalPrompt: '原始复刻 Prompt',
    originalNegativePrompt: '低画质',
    editState: 'dirty',
    semanticRevision: 1,
    optimizedRevision: 0,
    adjustInstruction: instruction,
  };
}

describe('buildPromptChangeSummary（先摘要后全文）', () => {
  it('无 recreation / 无意图 → null', () => {
    expect(buildPromptChangeSummary(null, [])).toBeNull();
    expect(buildPromptChangeSummary(stateWithInstruction(''), [])?.items ?? []).toHaveLength(0);
  });

  it('纯自由文本指令（无结构化行）→ 无条目', () => {
    const model = buildPromptChangeSummary(stateWithInstruction('整体更梦幻一些'), []);
    expect(model?.items ?? []).toHaveLength(0);
  });

  it('三维启用指令 → 人物 / 动作 / 背景 / 服装四类 planned 条目，顺序固定', () => {
    const instruction = [
      '把人物换成参考人物',
      '重点修改维度：人物、动作、背景',
      '动作修改（已启用）：原图动作不再保留——必须生成与原图明确不同的新动作',
      '背景修改（已启用）：背景内容不再照搬原图——背景中的动漫人物、屏幕内容与画面元素应随整体修改同步调整',
      '人物替换：使用图片库人物参考图（p.png）；主体人物必须整体替换为参考人物',
      '画面模板：以「原图」为画面模板——延续其画风、视觉氛围与整体画面气质',
      '服装处理：使用人物参考图中的服装（服装 / 造型 / 穿搭整体以人物参考图为准）',
    ].join('\n');
    const model = buildPromptChangeSummary(stateWithInstruction(instruction), [])!;
    expect(model.items.map(item => item.key)).toEqual(['subject', 'pose', 'scene', 'clothing']);
    expect(model.items.every(item => item.status === 'planned')).toBe(true);
    expect(model.items.find(item => item.key === 'pose')!.text).toContain('必须生成与原图明确不同的新动作');
    expect(model.items.find(item => item.key === 'clothing')!.text).toContain('使用人物参考图中的服装');
    // 画面模板进上下文行，不占维度条目
    expect(model.contextLines.some(line => line.startsWith('画面模板：'))).toBe(true);
  });

  it('优化成功后维度值变化 → 对应条目升级为 applied 并展示新值', () => {
    const state = stateWithInstruction('动作修改（已启用）：必须生成新动作');
    const applied = {
      ...state,
      editState: 'optimized' as const,
      plan: {
        ...state.plan,
        fields: state.plan.fields.map(field =>
          field.key === 'pose' ? { ...field, value: '双手在胸前组成比心手势', lockSource: 'intent' as const } : field,
        ),
      },
    };
    const model = buildPromptChangeSummary(applied, ['pose'])!;
    const pose = model.items.find(item => item.key === 'pose')!;
    expect(pose.status).toBe('applied');
    expect(pose.text).toBe('双手在胸前组成比心手势');
  });

  it('只有维度值变化（无指令行）→ 也生成 applied 条目', () => {
    const state = stateWithInstruction('');
    const applied = {
      ...state,
      plan: {
        ...state.plan,
        fields: state.plan.fields.map(field =>
          field.key === 'scene' ? { ...field, value: '夜晚霓虹街头', lockSource: 'intent' as const } : field,
        ),
      },
    };
    const model = buildPromptChangeSummary(applied, ['scene'])!;
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({ key: 'scene', label: '背景', status: 'applied', text: '夜晚霓虹街头' });
  });

  it('重点修改维度兜底行（无专行指令）→ 按标签映射出条目', () => {
    const model = buildPromptChangeSummary(stateWithInstruction('重点修改维度：镜头、风格'), [])!;
    expect(model.items.map(item => item.label)).toEqual(['镜头', '风格']);
  });

  it('超长指令行截断到一句话（摘要不堆长文）', () => {
    const long = `服装处理：更换为指定服装——${'非常长的服装描述'.repeat(20)}`;
    const model = buildPromptChangeSummary(stateWithInstruction(long), [])!;
    const clothing = model.items.find(item => item.key === 'clothing')!;
    expect(clothing.text.length).toBeLessThanOrEqual(73);
    expect(clothing.text.endsWith('…')).toBe(true);
  });
});
