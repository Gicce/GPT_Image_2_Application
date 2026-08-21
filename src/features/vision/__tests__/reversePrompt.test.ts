import { describe, it, expect } from 'vitest';
import { compileReversePrompt } from '../reversePrompt';
import type { VisionAnalysis } from '../../../types';

function emptyAnalysis(): VisionAnalysis {
  return {
    summary: '',
    subjects: [],
    objects: [],
    scene: { environment: '', location: '', time_of_day: '', weather: '', background: '', foreground: '' },
    composition: { subject_placement: '', symmetry: '', rule_of_thirds: null, horizon: null, negative_space: '', crop: '', depth_layers: '' },
    camera: { shot_type: '', focal_length_estimate: null, perspective: '', angle: '', depth_of_field: '', lens_characteristics: '' },
    lighting: { source: '', direction: '', softness: '', key_fill_rim: '', contrast: '', time_of_day: '', exposure: '' },
    colors: { dominant_palette: [], temperature: '', saturation: '', contrast: '' },
    style: { category: '', medium: '', texture: '', rendering: '', photographic_characteristics: '' },
    text_elements: [],
    fine_details: [],
    generation_risks: [],
  };
}

describe('ReversePromptCompiler（确定性编译）', () => {
  it('完整分析 → 分节齐全，主体节在最前', () => {
    const analysis = emptyAnalysis();
    analysis.summary = '红底保温杯产品图';
    analysis.subjects = [{
      label: '保温杯',
      count: 1,
      appearance: ['金属拉丝质感', '圆柱形'],
      pose: '直立摆放',
      action: null,
      position: { x: 0.35, y: 0.3, width: 0.3, height: 0.55 },
      orientation: '正面朝向镜头',
      clothing: [],
      relations: ['左侧有一片装饰绿叶'],
    }];
    analysis.scene.environment = '摄影棚';
    analysis.lighting.source = '柔光箱';
    analysis.camera.shot_type = '中景';
    analysis.style.category = 'realistic';

    const result = compileReversePrompt(analysis, 'gpt_image');
    expect(result.sections.subject).toContain('保温杯');
    expect(result.sections.subject).toContain('金属拉丝质感');
    expect(result.sections.subject).toContain('占画面约');
    expect(result.prompt.startsWith(result.sections.subject)).toBe(true);
    expect(result.prompt).toContain('摄影棚');
    expect(result.prompt).toContain('柔光箱');
    // GPT Image 方言以句号衔接
    expect(result.prompt).toMatch(/。$/);
  });

  it('多主体计数与客体位置进入构图节', () => {
    const analysis = emptyAnalysis();
    analysis.subjects = [
      { label: '模特', count: 2, appearance: [], pose: null, action: null, position: { x: 0.1, y: 0.2, width: 0.35, height: 0.7 }, orientation: null, clothing: ['白色连衣裙'], relations: [] },
    ];
    analysis.objects = [
      { label: '手提包', count: 1, position: { x: 0.6, y: 0.5, width: 0.15, height: 0.2 }, attributes: [] },
    ];
    const result = compileReversePrompt(analysis);
    expect(result.sections.subject).toContain('2 个模特');
    expect(result.sections.subject).toContain('白色连衣裙');
    expect(result.sections.composition).toContain('手提包');
  });

  it('带文字的图 → detail 节含文字内容，warnings 提示不可逆损失', () => {
    const analysis = emptyAnalysis();
    analysis.text_elements = [{ content: 'SUMMER SALE', position: { x: 0.3, y: 0.05, width: 0.4, height: 0.08 }, style: '粗体无衬线' }];
    const result = compileReversePrompt(analysis);
    expect(result.sections.detail).toContain('SUMMER SALE');
    expect(result.warnings.some(w => w.includes('文字'))).toBe(true);
    expect(result.negativePrompt).not.toContain('画面文字'); // 有文字时不把文字加入负面词
  });

  it('无文字的图 → 负面词包含「画面文字」防误生成', () => {
    const result = compileReversePrompt(emptyAnalysis());
    expect(result.negativePrompt).toContain('画面文字');
  });

  it('无主体 → warning 且推荐尺寸回落 1:1', () => {
    const analysis = emptyAnalysis();
    analysis.scene.environment = '海滩';
    const result = compileReversePrompt(analysis);
    expect(result.sections.subject).toBe('');
    expect(result.warnings.some(w => w.includes('主体'))).toBe(true);
    expect(result.recommended.size).toBe('1024x1024');
    expect(result.recommended.aspectRatio).toBe('1:1');
  });

  it('横幅信号 → 推荐 16:9 / 1792x1024', () => {
    const analysis = emptyAnalysis();
    analysis.camera.shot_type = 'wide landscape 全景';
    const result = compileReversePrompt(analysis);
    expect(result.recommended.aspectRatio).toBe('16:9');
    expect(result.recommended.size).toBe('1792x1024');
  });

  it('generic 与 gpt_image 方言输出不同衔接符', () => {
    const analysis = emptyAnalysis();
    analysis.scene.environment = '森林';
    analysis.camera.shot_type = '远景';
    const generic = compileReversePrompt(analysis, 'generic');
    const gpt = compileReversePrompt(analysis, 'gpt_image');
    expect(generic.prompt).toContain('，');
    expect(gpt.prompt.split('。').length).toBeGreaterThanOrEqual(generic.prompt.split('，').length);
  });

  it('空分析不抛错，输出为空 Prompt（调用方禁止提交空任务）', () => {
    const result = compileReversePrompt(emptyAnalysis());
    expect(result.prompt).toBe('');
    expect(Array.isArray(result.risks)).toBe(true);
  });
});
