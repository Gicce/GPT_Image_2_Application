import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { invoke } from '@tauri-apps/api/core';
import type { ReleaseNote } from '../store/useUpdateStore';

export type { Update };

export async function checkForUpdate(): Promise<Update | null> {
  return await check();
}

export async function fetchRecentReleases(): Promise<ReleaseNote[]> {
  try {
    return await invoke<ReleaseNote[]>('fetch_releases');
  } catch {
    return [];
  }
}

export async function downloadAndInstallUpdate(
  update: Update,
  onProgress: (downloaded: number, contentLength: number) => void
): Promise<void> {
  let downloaded = 0;
  let contentLength = 0;

  await update.downloadAndInstall((event) => {
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

export async function restartApp(): Promise<void> {
  await relaunch();
}
