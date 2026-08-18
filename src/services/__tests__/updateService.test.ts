import { describe, it, expect, vi } from 'vitest';

/**
 * describeUpdateError 文案映射测试（真实实现，非 mock）。
 * 锁死项：原始错误（含 reqwest 的 URL 明文）绝不透出给用户。
 */

vi.mock('@tauri-apps/plugin-updater', () => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { describeUpdateError } from '../updateService';

describe('describeUpdateError 语境化错误映射', () => {
  it('下载阶段 reqwest 原始错误（V4.0.2 实际截图场景）=> 「更新下载失败」且不透出 URL', () => {
    const msg = describeUpdateError(
      new Error('error sending request for url (https://github.com/Gicce/GPT_Image_2_Application/releases/download/v4.0.3/CyImagePro_4.0.3_x64-setup.exe)'),
      'download'
    );
    expect(msg).toContain('更新下载失败');
    expect(msg).not.toContain('检查更新失败');
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toContain('github.com');
  });

  it('下载阶段网络错误 => 「更新下载失败」+ 友好文案', () => {
    const msg = describeUpdateError(new Error('network timeout while downloading'), 'download');
    expect(msg).toContain('更新下载失败');
    expect(msg).toContain('暂时无法连接更新服务器');
  });

  it('检查阶段网络错误 => 「检查更新失败」', () => {
    const msg = describeUpdateError(new Error('network error'), 'check');
    expect(msg).toContain('检查更新失败');
    expect(msg).not.toContain('更新下载失败');
  });

  it('签名校验失败（安全失败）=> 明确中止文案，按语境前缀', () => {
    expect(describeUpdateError(new Error('signature validation failed'), 'download')).toContain('签名校验失败');
    expect(describeUpdateError(new Error('signature invalid'), 'check')).toContain('签名校验失败');
  });

  it('404 => 未找到更新文件', () => {
    const msg = describeUpdateError(new Error('404 Not Found'), 'download');
    expect(msg).toContain('未找到更新文件');
  });

  it('未知错误 => 通用文案，绝不透出原始消息', () => {
    const msg = describeUpdateError(new Error('some weird internal detail https://evil.example'), 'install');
    expect(msg).toContain('更新安装失败');
    expect(msg).not.toMatch(/https?:\/\//);
    expect(msg).not.toContain('weird');
  });
});
