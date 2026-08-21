import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildDroppedChatAttachmentDraft } from '../chatDropAttachments';

/**
 * AI 对话拖图（V4.0.8）：
 * 拖入图片与「添加照片」按钮产生完全同构的 ChatAttachment（同一附件体系，
 * 不是第三套拖拽附件）；拖入只添加附件，绝不自动发送。
 */

describe('buildDroppedChatAttachmentDraft', () => {
  it('与「添加照片」按钮的附件结构完全一致（image / upload / dataUrl / filePath）', () => {
    const draft = buildDroppedChatAttachmentDraft(
      { path: 'D:\\pics\\hero.png', name: 'hero.png' },
      'data:image/png;base64,xxxx',
    );
    expect(draft).toEqual({
      type: 'image',
      source: 'upload',
      name: 'hero.png',
      dataUrl: 'data:image/png;base64,xxxx',
      filePath: 'D:\\pics\\hero.png',
    });
  });

  it('保留本地路径：task 模式下可作为参考图 / 编辑源图参与任务规划', () => {
    const draft = buildDroppedChatAttachmentDraft({ path: 'D:/a.jpg', name: 'a.jpg' }, 'data:image/jpeg;base64,y');
    expect(draft.filePath).toBe('D:/a.jpg');
    expect(draft.type).toBe('image');
  });
});

describe('源码守卫：拖入不触发发送', () => {
  it('Chat 拖入处理只构造附件，不调用 sendMessage / handleSend', () => {
    const source = readFileSync(fileURLToPath(new URL('../../pages/Chat.tsx', import.meta.url)), 'utf-8');
    const start = source.indexOf('async function acceptDroppedChatImages');
    expect(start).toBeGreaterThan(-1);
    const region = source.slice(start, source.indexOf('\n  }', start) + 4);
    expect(region).toContain('buildDroppedChatAttachmentDraft');
    expect(region).not.toContain('sendMessage');
    expect(region).not.toContain('handleSend');
    expect(region).not.toContain('sendTaskMessage');
  });
});
