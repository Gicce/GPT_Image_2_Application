import {
  EXPLICIT_IMAGE_GENERATION_PATTERN,
  GALLERY_RECALL_PATTERN,
  IMAGE_EDIT_PATTERN,
  IMAGE_UNDERSTANDING_PATTERN,
  REMOVE_BACKGROUND_PATTERN,
} from './agentPatterns';

export type AgentIntent =
  | 'chat'
  | 'gallery_search'
  | 'image_understanding'
  | 'image_generate'
  | 'image_edit'
  | 'remove_background';

export type IntentInput = {
  text: string;
  hasImageAttachments?: boolean;
  hasEditableImage?: boolean;
  planOnly?: boolean;
};

function normalizeIntentText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

const EXECUTION_CONFIRMATION_ONLY_PATTERN =
  /^(?:直接)?(?:出图|生图|执行|开始执行)$|^(?:按这个版本|根据你的内容|就按这个|就按这个执行|按刚才这版|按这版)(?:直接)?(?:出图|生图|执行|生成)$/i;

function isExplicitImageGenerateRequest(text: string): boolean {
  if (!text || EXECUTION_CONFIRMATION_ONLY_PATTERN.test(text)) return false;

  const cleanGenerationPattern =
    /(生成|制作|创建|设计|画|做一张|做几张|帮我做|给我做|给我制作|帮我制作).*(图|图片|图像|海报|头像|图标|logo|主图|详情图|说明图|测量图|长图|封面图|A\+图|a\+图)/i;

  return cleanGenerationPattern.test(text) || EXPLICIT_IMAGE_GENERATION_PATTERN.test(text);
}

export function classifyAgentIntent(input: IntentInput): AgentIntent {
  const text = normalizeIntentText(input.text);
  const hasImageAttachments = !!input.hasImageAttachments;
  const hasEditableImage = !!input.hasEditableImage;

  if (input.planOnly || !text) return 'chat';

  if (!hasImageAttachments && GALLERY_RECALL_PATTERN.test(text)) {
    return 'gallery_search';
  }

  if (hasImageAttachments && IMAGE_UNDERSTANDING_PATTERN.test(text)) {
    return 'image_understanding';
  }

  if (hasEditableImage && REMOVE_BACKGROUND_PATTERN.test(text)) {
    return 'remove_background';
  }

  if (hasEditableImage && IMAGE_EDIT_PATTERN.test(text)) {
    return 'image_edit';
  }

  if (!hasImageAttachments && isExplicitImageGenerateRequest(text)) {
    return 'image_generate';
  }

  return 'chat';
}
