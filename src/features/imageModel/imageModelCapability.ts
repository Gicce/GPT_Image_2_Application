/**
 * 图片执行模型能力单一来源（V4.0.8）—— 图片任务 capability 门禁唯一判定入口。
 *
 * 事实源：
 *  - V4 服务端图片目录 enabled_models 仅 gpt-image-2（服务端计费，见 serverApi）；
 *  - Rust task_runner 的图片执行 model 恒为该常量（前端不传模型）；
 *  - gpt-image-2 同时支持文生图（/v1/images/generations）与图生图（/v1/images/edits）。
 *
 * 职责边界（模型职责隔离，V4.0.8 硬约束）：
 *  - Chat / Planner / Prompt Optimizer / Vision 模型全部来自用户 BYOK Provider
 *    （resolveByokConfigForUse / resolveByokVisionConfig），绝不允许进入图片执行链；
 *  - 图片执行模型只来自本模块目录 —— 与 BYOK 体系无交集，禁止 selectedModel 之类的
 *    模糊 fallback 把文本模型当图片模型。
 *
 * 判定依据是显式 capability，不是 endpoint 名或模型名字符串猜测。
 * 未来服务端图片模型扩容时只需扩充 IMAGE_MODEL_CATALOG。
 */

export type ImageGenerationKind = 't2i' | 'i2i';

export interface ImageModelDescriptor {
  id: string;
  displayName: string;
  capabilities: {
    image_generation: boolean;
    image_edit: boolean;
  };
}

/** V4 服务端图片模型目录（enabled_models 的事实镜像）。 */
export const IMAGE_MODEL_CATALOG: ImageModelDescriptor[] = [
  {
    id: 'gpt-image-2',
    displayName: 'GPT Image 2',
    capabilities: { image_generation: true, image_edit: true },
  },
];

/** 当前生效的图片执行模型（单模型目录取第一个；扩容后由设置页显式选择）。 */
export function imageExecutionModelId(): string {
  return IMAGE_MODEL_CATALOG[0]?.id ?? '';
}

export function imageModelById(id: string): ImageModelDescriptor | null {
  return IMAGE_MODEL_CATALOG.find(model => model.id === id) ?? null;
}

/** 生成方式 → capability 需求：文生图要 image_generation，图生图要 image_edit。 */
export function imageModelsForKind(kind: ImageGenerationKind): ImageModelDescriptor[] {
  return IMAGE_MODEL_CATALOG.filter(model =>
    kind === 'i2i' ? model.capabilities.image_edit : model.capabilities.image_generation,
  );
}

export function imageModelSupportsKind(
  kind: ImageGenerationKind,
  modelId: string = imageExecutionModelId(),
): boolean {
  return imageModelsForKind(kind).some(model => model.id === modelId);
}

/** 生成方式 → 任务 task_type（与 Rust task_runner 分发一一对应）。 */
export function imageTaskTypeForKind(kind: ImageGenerationKind): 'generate' | 'edit' {
  return kind === 'i2i' ? 'edit' : 'generate';
}

/** task_type → 生成方式（非图片生成任务返回 null）。 */
export function imageKindForTaskType(taskType: string): ImageGenerationKind | null {
  if (taskType === 'edit') return 'i2i';
  if (taskType === 'generate') return 't2i';
  return null;
}

export interface ImageModelGateResult {
  allowed: boolean;
  /** allowed=false 时的阻断文案（展示层直接使用，不二次拼接）。 */
  message?: string;
}

/** 提交前 capability 门禁：模型不支持当前生成方式时在客户端阻断，不等上游报错。 */
export function gateImageModelForKind(kind: ImageGenerationKind): ImageModelGateResult {
  if (imageModelSupportsKind(kind)) return { allowed: true };
  return {
    allowed: false,
    message: kind === 'i2i'
      ? '当前图片模型不支持图生图，请切换支持图片编辑的模型。'
      : '当前图片模型不支持文生图，请切换支持图片生成的模型。',
  };
}
