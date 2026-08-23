import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 源码守卫（V4.0.8 任务图片按会话隔离）：
 * 防止回归到 —— 页面级全局附件数组、「空数组 = 未初始化」式自动绑定、
 * 无 conversation 作用域的附件写入。
 */

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');
}

function section(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `找不到起始锚点：${startMarker}`).toBeGreaterThan(-1);
  const end = source.indexOf(endMarker, start);
  expect(end, `找不到结束锚点：${endMarker}`).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe('Chat.tsx：Composer 草稿必须按 conversation 隔离', () => {
  const source = readSource('../../pages/Chat.tsx');

  it('页面级附件容器 attachmentsByMode 已彻底移除', () => {
    expect(source).not.toContain('attachmentsByMode');
    expect(source).not.toMatch(/useState<\{\s*chat:/);
  });

  it('附件/输入读写走 useConversationDraftStore', () => {
    expect(source).toContain('useConversationDraftStore');
    expect(source).toContain('ANONYMOUS_DRAFT_KEY');
  });

  it('所有异步图片入口在 await 前捕获 (key, mode) 目标，防跨会话写入', () => {
    // 本地选择 / 拖入 / 图库选择 / 图库结果 / 文件 / 删除 / 清空
    const captures = source.match(/currentComposerTarget\(\)/g) || [];
    expect(captures.length).toBeGreaterThanOrEqual(6);
    // 拖入处理函数必须先捕获再读图
    const dropSection = section(source, 'async function acceptDroppedChatImages', 'const { dragActive: chatDragActive }');
    expect(dropSection).toContain('currentComposerTarget()');
    expect(dropSection.indexOf('currentComposerTarget()')).toBeLessThan(dropSection.indexOf('api.readImageData'));
  });

  it('任务附件写入后同步绑定四态（none → manual 收敛入口）', () => {
    expect(source).toContain('syncTaskImageBinding');
  });
});

describe('useChatStore.ts：自动绑定只允许 uninitialized；none 持久化', () => {
  const source = readSource('../../store/useChatStore.ts');

  it('restoreActiveImageIds 以四态守卫（禁止「空数组=未初始化」式判断）', () => {
    const restoreSection = section(source, 'export function restoreActiveImageIds', 'async function planTaskCore');
    expect(restoreSection).toContain('canAutoBindTaskImage');
    // 旧的「仅凭 active_image_id 为空就 continue 扫描」守卫必须消失
    expect(source).not.toMatch(/if \(conv\.active_image_id && conv\.active_image_path\) continue;/);
  });

  it('任务成功推进 active_image 必须经过 none + 只前进守卫', () => {
    const syncSection = section(source, 'syncTaskMessage: async', 'reconcileTaskMessages: async');
    expect(syncSection).toContain('shouldAdvanceActiveImageOnTaskSuccess');
    expect(syncSection).toContain("active_image_binding: 'auto'");
  });

  it('setActiveImageId 解绑时写入绑定四态', () => {
    const setSection = section(source, 'setActiveImageId: (conversationId', 'syncTaskImageBinding: (conversationId)');
    expect(setSection).toContain('active_image_binding');
    expect(setSection).toContain('deriveTaskImageBindingAfterUserChange');
  });

  it('会话生命周期：newConversation 迁移匿名草稿；deleteConversation 清理草稿', () => {
    const newSection = section(source, 'newConversation: () =>', 'switchConversation: (id)');
    expect(newSection).toContain('adoptDraft(ANONYMOUS_DRAFT_KEY');

    const deleteSection = section(source, 'deleteConversation: (id)', 'renameConversation: (id');
    expect(deleteSection).toContain('deleteDraft');
  });

  it('绑定四态随会话持久化（buildPersistedConversation 含字段）', () => {
    const persistSection = section(source, 'function buildPersistedConversation', 'function buildPersistedConversationSnapshot');
    expect(persistSection).toContain('active_image_binding');
  });
});

describe('useConversationDraftStore.ts：草稿以 conversationId 为 key', () => {
  const source = readSource('../../store/useConversationDraftStore.ts');

  it('提供按 key 的增删清与迁移/清理 API', () => {
    expect(source).toContain('drafts: Record<string, ConversationComposerDraft>');
    expect(source).toContain('addModeAttachment');
    expect(source).toContain('removeModeAttachment');
    expect(source).toContain('clearModeAttachments');
    expect(source).toContain('adoptDraft');
    expect(source).toContain('deleteDraft');
  });
});
