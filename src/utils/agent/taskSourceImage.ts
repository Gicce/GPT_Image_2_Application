import type { ChatMessage } from '../../types';

/**
 * 任务源图片选择的唯一事实源（Source Image Resolver）。
 *
 * 架构原则：
 *   - Planner 只决定「这是文生图还是图生图」（intent / task_type）。
 *   - 「图生图到底用哪一张」由应用层在这里决定， Planner 输出的
 *     source_image_id 仅作参考、绝不作为执行依据。
 *   - 解析结果在 Task 创建时快照固化（sourceImageId / sourceImagePath），
 *     之后执行阶段只读快照，禁止再次 resolve。
 *
 * 优先级（与产品约定一致）：
 *   1. 当前用户消息显式上传/附加的图片（附件任务：第一张附件为编辑目标）
 *   2. 会话 active image 中由用户显式绑定的（「编辑此图」按钮）
 *   3. 会话 active image 中的自动绑定（上一张成功图）
 *   4. 当前对话最后一张有效图片（时间序，不依赖数组 index / 渲染顺序）
 *   5. 无图片
 */
export type SourceImageSelection = 'latest' | 'explicit' | 'attachment' | 'none';

export interface ConversationImageOption {
  /** 稳定图片 ID（图库 imageId）；上传附件为附件 id。 */
  imageId: string;
  /** 已水合的预览 URL（data URL / asset 协议 URL），仅展示用。 */
  url?: string;
  localPath?: string;
  fileName?: string;
  /** 近似时间（任务卡 createdAt / 消息 created_at），用于排序与展示。 */
  createdAt?: string;
  /** 图片来源：任务生成 / 用户上传附件。 */
  source: 'generated' | 'uploaded';
  taskMessageId?: string;
}

/**
 * 按时间正序收集当前对话的所有可用图片（生成图 + 用户上传附件），
 * 按 imageId / localPath 去重。数组末尾恒为「最新一张」。
 *
 * 不依赖 messages 数组 index 语义 —— 只按消息时间顺序追加；
 * 同一任务多图按图片列表倒序回填（图片 store 为 DESC，最新在前）。
 */
export function collectConversationImages(messages: ChatMessage[]): ConversationImageOption[] {
  const out: ConversationImageOption[] = [];
  const seen = new Set<string>();
  const push = (option: ConversationImageOption) => {
    const key = option.imageId || (option.localPath ? `path:${option.localPath}` : '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(option);
  };
  for (const message of messages) {
    if (message.role === 'user' && message.attachments) {
      for (const att of message.attachments) {
        if (att.type !== 'image' || !att.filePath) continue;
        push({
          imageId: att.id,
          url: att.dataUrl,
          localPath: att.filePath,
          fileName: att.name,
          createdAt: message.created_at,
          source: 'uploaded',
        });
      }
    }
    const tm = message.task_message;
    if (tm && tm.stage === 'success' && tm.images && tm.images.length > 0) {
      for (let i = tm.images.length - 1; i >= 0; i -= 1) {
        const img = tm.images[i];
        push({
          imageId: img.imageId || img.id,
          url: img.url,
          localPath: img.localPath,
          fileName: img.file_name,
          createdAt: tm.createdAt || message.created_at,
          source: 'generated',
          taskMessageId: message.id,
        });
      }
    }
  }
  return out;
}

export function latestConversationImage(messages: ChatMessage[]): ConversationImageOption | null {
  const images = collectConversationImages(messages);
  return images.length > 0 ? images[images.length - 1] : null;
}

export interface ResolvedConversationSourceImage {
  sourceImageId: string | null;
  sourceImagePath: string | null;
  sourceImagePreviewUrl?: string;
  sourceImageFileName?: string;
  /** 'explicit' = 用户显式绑定；'latest' = 对话默认（上一张/最新）；'none' = 无图。 */
  selection: Exclude<SourceImageSelection, 'attachment'>;
}

/**
 * 解析会话级源图（不含当轮附件 —— 附件优先级在调用方处理，因为附件
 * 不进入会话历史、由 Composer 实时持有）。
 */
export function resolveConversationSourceImage(input: {
  messages: ChatMessage[];
  activeImageId?: string | null;
  activeImagePath?: string | null;
  activeImageSource?: 'explicit' | 'auto';
}): ResolvedConversationSourceImage {
  const options = collectConversationImages(input.messages);
  const byId = new Map(options.map(option => [option.imageId, option] as const));
  const byPath = new Map(
    options.filter(option => option.localPath).map(option => [option.localPath as string, option] as const),
  );

  if (input.activeImageId || input.activeImagePath) {
    const found = (input.activeImageId ? byId.get(input.activeImageId) : undefined)
      || (input.activeImagePath ? byPath.get(input.activeImagePath) : undefined);
    if (found) {
      return {
        sourceImageId: found.imageId,
        sourceImagePath: found.localPath ?? input.activeImagePath ?? null,
        sourceImagePreviewUrl: found.url,
        sourceImageFileName: found.fileName,
        selection: input.activeImageSource === 'explicit' ? 'explicit' : 'latest',
      };
    }
    // active 指向的图片已不在会话里（消息被删 / 文件被删）：
    // 会话级默认可以退回最新一张（任务级快照不存在漂移问题 —— 任务卡上的绑定
    // 在创建时已固化，且执行层会校验文件存在性）。
  }

  const latest = options.length > 0 ? options[options.length - 1] : null;
  if (latest) {
    return {
      sourceImageId: latest.imageId,
      sourceImagePath: latest.localPath ?? null,
      sourceImagePreviewUrl: latest.url,
      sourceImageFileName: latest.fileName,
      selection: 'latest',
    };
  }
  return {
    sourceImageId: null,
    sourceImagePath: null,
    selection: 'none',
  };
}

/** 任务卡「图片引用」行的展示文案。 */
export function sourceImageSelectionLabel(selection: SourceImageSelection | undefined): string {
  switch (selection) {
    case 'attachment': return '本轮上传图片';
    case 'explicit': return '已手动选择';
    case 'latest': return '上一张图片';
    case 'none': return '未引用图片';
    default: return '未引用图片';
  }
}
