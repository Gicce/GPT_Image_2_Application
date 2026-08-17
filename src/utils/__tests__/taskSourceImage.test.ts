import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '../../types';
import {
  collectConversationImages,
  latestConversationImage,
  resolveConversationSourceImage,
  sourceImageSelectionLabel,
} from '../agent/taskSourceImage';

function taskMessageMessage(overrides: Partial<ChatMessage['task_message']>): ChatMessage {
  return {
    id: 'm_task',
    role: 'assistant',
    content: '',
    created_at: '2026-08-17T10:00:00Z',
    task_message: {
      taskId: 'task_1',
      status: 'completed',
      stage: 'success',
      title: 't',
      createdAt: '2026-08-17T10:00:00Z',
      updatedAt: '2026-08-17T10:00:00Z',
      ...overrides,
    } as ChatMessage['task_message'],
  };
}

function successImages(images: Array<{ id: string; path: string }>, createdAt: string): ChatMessage {
  return taskMessageMessage({
    images: images.map(img => ({
      id: img.id,
      imageId: img.id,
      url: `asset://${img.id}`,
      localPath: img.path,
      file_name: img.path.split('/').pop(),
    })),
    createdAt,
  });
}

describe('collectConversationImages', () => {
  it('按消息时间正序收集生成图，末位为最新', () => {
    const messages = [
      successImages([{ id: 'img_a', path: 'D:/out/a.png' }], '2026-08-17T10:00:00Z'),
      successImages([{ id: 'img_b', path: 'D:/out/b.png' }], '2026-08-17T11:00:00Z'),
      successImages([{ id: 'img_c', path: 'D:/out/c.png' }], '2026-08-17T12:00:00Z'),
    ];
    const options = collectConversationImages(messages);
    expect(options.map(o => o.imageId)).toEqual(['img_a', 'img_b', 'img_c']);
    expect(latestConversationImage(messages)?.imageId).toBe('img_c');
  });

  it('同一任务多图按时间倒序回填（store 内 DESC，最新在前）', () => {
    const messages = [successImages(
      [
        { id: 'img_2', path: 'D:/out/2.png' },
        { id: 'img_1', path: 'D:/out/1.png' },
      ],
      '2026-08-17T10:00:00Z',
    )];
    const options = collectConversationImages(messages);
    expect(options.map(o => o.imageId)).toEqual(['img_1', 'img_2']);
  });

  it('非成功任务卡与用户上传附件分别过滤 / 收集', () => {
    const messages: ChatMessage[] = [
      {
        id: 'm_user',
        role: 'user',
        content: '改一下',
        created_at: '2026-08-17T09:00:00Z',
        attachments: [
          { id: 'att_1', type: 'image', source: 'upload', name: 'up.png', filePath: 'D:/tmp/up.png' },
          { id: 'att_2', type: 'file', source: 'upload', name: 'note.txt' },
        ],
      },
      taskMessageMessage({ stage: 'failed' }),
      successImages([{ id: 'img_a', path: 'D:/out/a.png' }], '2026-08-17T10:00:00Z'),
    ];
    const options = collectConversationImages(messages);
    expect(options.map(o => o.imageId)).toEqual(['att_1', 'img_a']);
    expect(options[0].source).toBe('uploaded');
    expect(options[1].source).toBe('generated');
  });

  it('按 imageId 去重（同图多处出现只保留首个）', () => {
    const messages = [
      successImages([{ id: 'img_a', path: 'D:/out/a.png' }], '2026-08-17T10:00:00Z'),
      successImages([{ id: 'img_a', path: 'D:/out/a.png' }], '2026-08-17T11:00:00Z'),
    ];
    expect(collectConversationImages(messages)).toHaveLength(1);
  });
});

describe('resolveConversationSourceImage', () => {
  const messages = [
    successImages([{ id: 'img_a', path: 'D:/out/a.png' }], '2026-08-17T10:00:00Z'),
    successImages([{ id: 'img_b', path: 'D:/out/b.png' }], '2026-08-17T11:00:00Z'),
    successImages([{ id: 'img_c', path: 'D:/out/c.png' }], '2026-08-17T12:00:00Z'),
  ];

  it('无 active image 时默认绑定对话最后一张（latest）', () => {
    const resolved = resolveConversationSourceImage({ messages });
    expect(resolved.sourceImageId).toBe('img_c');
    expect(resolved.sourceImagePath).toBe('D:/out/c.png');
    expect(resolved.selection).toBe('latest');
  });

  it('auto active image 绑定该图且 selection=latest', () => {
    const resolved = resolveConversationSourceImage({
      messages,
      activeImageId: 'img_b',
      activeImagePath: 'D:/out/b.png',
      activeImageSource: 'auto',
    });
    expect(resolved.sourceImageId).toBe('img_b');
    expect(resolved.selection).toBe('latest');
  });

  it('用户显式绑定的 active image selection=explicit（「编辑此图」）', () => {
    const resolved = resolveConversationSourceImage({
      messages,
      activeImageId: 'img_a',
      activeImagePath: 'D:/out/a.png',
      activeImageSource: 'explicit',
    });
    expect(resolved.sourceImageId).toBe('img_a');
    expect(resolved.selection).toBe('explicit');
  });

  it('active image 指向已删除的图时退回最新一张', () => {
    const resolved = resolveConversationSourceImage({
      messages,
      activeImageId: 'img_deleted',
      activeImagePath: 'D:/out/deleted.png',
    });
    expect(resolved.sourceImageId).toBe('img_c');
    expect(resolved.selection).toBe('latest');
  });

  it('无任何图片时返回 none', () => {
    const resolved = resolveConversationSourceImage({ messages: [] });
    expect(resolved.sourceImageId).toBeNull();
    expect(resolved.sourceImagePath).toBeNull();
    expect(resolved.selection).toBe('none');
  });
});

describe('sourceImageSelectionLabel', () => {
  it('四种绑定方式各有明确文案', () => {
    expect(sourceImageSelectionLabel('latest')).toBe('上一张图片');
    expect(sourceImageSelectionLabel('explicit')).toBe('已手动选择');
    expect(sourceImageSelectionLabel('attachment')).toBe('本轮上传图片');
    expect(sourceImageSelectionLabel('none')).toBe('未引用图片');
    expect(sourceImageSelectionLabel(undefined)).toBe('未引用图片');
  });
});
