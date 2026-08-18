import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNote } from '../store/useUpdateStore';

export type { Update };

export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

export async function fetchRecentReleases(): Promise<ReleaseNote[]> {
  return await invoke<ReleaseNote[]>('fetch_releases');
}

export type DownloadProgressHandler = (downloaded: number, contentLength: number) => void;

/** 仅下载更新包，不安装；完成后由用户确认重启再执行 installUpdate。 */
export async function downloadUpdate(
  update: Update,
  onProgress: DownloadProgressHandler
): Promise<void> {
  let downloaded = 0;
  let contentLength = 0;

  await update.download((event) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength ?? 0;
        onProgress(0, contentLength);
        break;
      case 'Progress':
        downloaded += event.data.chunkLength;
        onProgress(downloaded, contentLength);
        break;
      case 'Finished':
        onProgress(contentLength, contentLength);
        break;
    }
  });
}

/** 安装已下载的更新（Windows NSIS passive 模式），随后由调用方 relaunch。 */
export async function installUpdate(update: Update): Promise<void> {
  await update.install();
}

export async function restartApp(): Promise<void> {
  await relaunch();
}

/** 错误发生的阶段：决定用户可读文案的前缀与语义（检查 / 下载 / 安装） */
export type UpdateErrorContext = 'check' | 'download' | 'install';

/**
 * 将 updater 异常映射为用户可读的中文提示（按发生阶段区分语义）。
 * 只描述错误类别；原始错误（含 reqwest 的 URL 明文）仅进入诊断日志，绝不展示给用户，
 * 也绝不输出签名密钥等内容。
 */
export function describeUpdateError(error: unknown, context: UpdateErrorContext = 'check'): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const text = message.toLowerCase();
  const prefix = context === 'download' ? '更新下载失败' : context === 'install' ? '更新安装失败' : '检查更新失败';
  if (text.includes('signature')) {
    return `${prefix}：安装包签名校验失败，已中止。`;
  }
  if (text.includes('network') || text.includes('timeout') || text.includes('timed out')
    || text.includes('connect') || text.includes('error sending request')) {
    return `${prefix}：暂时无法连接更新服务器，请检查网络后重试。`;
  }
  if (text.includes('404') || text.includes('not found')) {
    return `${prefix}：未找到更新文件，请稍后重试。`;
  }
  console.warn(`[updater:${context}] ${message}`);
  return `${prefix}，请稍后重试。`;
}
