/**
 * 拖入图片 → 对话附件草稿（V4.0.8）—— 与「添加照片」按钮 / 图库选择 / 粘贴
 * 走同一 ChatAttachment 结构，绝不产生第三套附件形态。
 * 只构造附件（type=image、source=upload、保留本地 filePath 供任务模式作参考图），
 * 不发送、不触发任何模型调用 —— 发送仍由用户显式点击。
 */

import type { ChatAttachment } from '../types';
import type { DroppedImageFile } from './imageDropFiles';

export function buildDroppedChatAttachmentDraft(
  file: DroppedImageFile,
  dataUrl: string,
): Omit<ChatAttachment, 'id'> {
  return {
    type: 'image',
    source: 'upload',
    name: file.name,
    dataUrl,
    filePath: file.path,
  };
}
