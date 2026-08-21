import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODEL_CATALOG,
  gateImageModelForKind,
  imageExecutionModelId,
  imageKindForTaskType,
  imageModelsForKind,
  imageModelSupportsKind,
  imageTaskTypeForKind,
} from '../imageModelCapability';

/**
 * 图片执行模型 capability（V4.0.8）：
 * 文生图只认 image_generation，图生图只认 image_edit；判定依据是显式
 * capability 目录，不是 endpoint 名或模型名字符串猜测。
 */

describe('capability 过滤', () => {
  it('文生图列表只包含 image_generation 模型', () => {
    const models = imageModelsForKind('t2i');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(model.capabilities.image_generation).toBe(true);
  });

  it('图生图列表只包含 image_edit 模型', () => {
    const models = imageModelsForKind('i2i');
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) expect(model.capabilities.image_edit).toBe(true);
  });

  it('两个能力都支持的模型在两种模式下都出现（gpt-image-2）', () => {
    expect(imageModelsForKind('t2i').some(m => m.id === 'gpt-image-2')).toBe(true);
    expect(imageModelsForKind('i2i').some(m => m.id === 'gpt-image-2')).toBe(true);
    expect(imageExecutionModelId()).toBe('gpt-image-2');
  });

  it('目录外模型 id 判定不支持（禁止按名字猜测放行）', () => {
    expect(imageModelSupportsKind('i2i', 'deepseek-v4-flash')).toBe(false);
    expect(imageModelSupportsKind('t2i', 'glm-4.6v')).toBe(false);
    expect(IMAGE_MODEL_CATALOG.some(m => m.id === 'deepseek-v4-flash')).toBe(false);
  });
});

describe('生成方式 ↔ task_type 映射（与 Rust 路由一一对应）', () => {
  it('i2i → edit，t2i → generate', () => {
    expect(imageTaskTypeForKind('i2i')).toBe('edit');
    expect(imageTaskTypeForKind('t2i')).toBe('generate');
  });

  it('task_type → 生成方式；非图片生成任务返回 null', () => {
    expect(imageKindForTaskType('edit')).toBe('i2i');
    expect(imageKindForTaskType('generate')).toBe('t2i');
    expect(imageKindForTaskType('remove_background')).toBeNull();
    expect(imageKindForTaskType('vision_understanding')).toBeNull();
  });
});

describe('提交前 capability 门禁', () => {
  it('当前目录模型双能力齐备 → 放行', () => {
    expect(gateImageModelForKind('t2i').allowed).toBe(true);
    expect(gateImageModelForKind('i2i').allowed).toBe(true);
  });

  it('目录改为仅文生图模型时，图生图被客户端阻断并给出切换提示（不等上游报错）', () => {
    const original = IMAGE_MODEL_CATALOG.splice(0, IMAGE_MODEL_CATALOG.length, {
      id: 't2i-only-model',
      displayName: 'T2I Only',
      capabilities: { image_generation: true, image_edit: false },
    });
    try {
      const gate = gateImageModelForKind('i2i');
      expect(gate.allowed).toBe(false);
      expect(gate.message).toBe('当前图片模型不支持图生图，请切换支持图片编辑的模型。');
      expect(gateImageModelForKind('t2i').allowed).toBe(true);
    } finally {
      IMAGE_MODEL_CATALOG.splice(0, IMAGE_MODEL_CATALOG.length, ...original);
    }
  });
});
