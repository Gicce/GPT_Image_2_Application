import { Command } from '@tauri-apps/plugin-shell';
import { toastError } from '../components/Toast';

/**
 * 统一剪贴板写入：优先 clip.exe（Tauri WebView 中 navigator.clipboard 可能被拒），
 * 失败回落 navigator.clipboard。返回是否成功，失败时弹 Toast。
 */
export async function copyText(text: string, failHint = '复制失败，请重试'): Promise<boolean> {
  let ok = false;
  try {
    const cmd = Command.create('clip', [], { encoding: 'raw' });
    const child = await cmd.spawn();
    await child.write(new TextEncoder().encode(text));
    await child.kill();
    ok = true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) toastError(failHint);
  return ok;
}
