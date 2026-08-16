import { api } from './api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAuthStore } from '../store/useAuthStore';

/**
 * 统一 Avatar Service：本地上传与「生成图片 → 设为头像」共用同一保存逻辑。
 *
 * 头像以独立 data URL 副本保存在 settings.user_avatar_data_url（沿用项目现有体系），
 * 不引用素材原文件 —— 删除原生成图片后头像不受影响。
 * 另按账号 userId 在 localStorage 缓存一份，切换账号时恢复各自头像。
 */

const AVATAR_SIZE = 512;
const AVATAR_CACHE_KEY = 'cy_user_avatars';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('头像图片加载失败，请换一张图片试试'));
    img.src = src;
  });
}

/** 中心裁剪为 1:1 正方形并缩放到 512×512，优先输出 WebP（不支持时回落 PNG） */
function renderSquareAvatar(img: HTMLImageElement): string {
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法处理图片（画布不可用）');
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

function readAvatarCache(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AVATAR_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAvatarCache(map: Record<string, string>): void {
  try {
    localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(map));
  } catch {
    // 缓存写入失败不影响主流程（settings 中的头像仍已保存）
  }
}

function currentUserId(): string | null {
  return useAuthStore.getState().user?.id ?? null;
}

/** 读取本地图片文件 → 裁剪缩放 → 保存为当前头像（独立副本） */
export async function setAsAvatarFromPath(path: string): Promise<void> {
  const dataUrl = await api.readImageData(path);
  await setAsAvatarFromDataUrl(dataUrl);
}

/** 任意图片 data URL（生成图预览、图库原图等）→ 裁剪缩放 → 保存为当前头像 */
export async function setAsAvatarFromDataUrl(dataUrl: string): Promise<void> {
  const img = await loadImage(dataUrl);
  const avatar = renderSquareAvatar(img);
  await useSettingsStore.getState().saveSettings({ user_avatar_data_url: avatar });
  const uid = currentUserId();
  if (uid) {
    const map = readAvatarCache();
    map[uid] = avatar;
    writeAvatarCache(map);
  }
}

/** 清除当前账号头像（账户页「清除」按钮） */
export async function clearAvatar(): Promise<void> {
  await useSettingsStore.getState().saveSettings({ user_avatar_data_url: '' });
  const uid = currentUserId();
  if (uid) {
    const map = readAvatarCache();
    if (uid in map) {
      delete map[uid];
      writeAvatarCache(map);
    }
  }
}

/**
 * 账号切换时同步头像：
 * - 登录：恢复该账号缓存的头像；首次登录则把当前头像挂到该账号名下（迁移）
 * - 登出：清空展示中的头像，避免下一个账号看到上一位用户的头像
 * 返回取消订阅函数（App 挂载时调用一次）。
 */
export function initAvatarAccountSync(): () => void {
  let lastUserId = useAuthStore.getState().user?.id ?? null;
  return useAuthStore.subscribe(state => {
    const uid = state.user?.id ?? null;
    if (uid === lastUserId) return;
    lastUserId = uid;

    if (!uid) {
      const current = useSettingsStore.getState().settings.user_avatar_data_url;
      if (current) {
        void useSettingsStore.getState().saveSettings({ user_avatar_data_url: '' });
      }
      return;
    }

    const map = readAvatarCache();
    const cached = map[uid];
    const current = useSettingsStore.getState().settings.user_avatar_data_url;
    if (cached) {
      if (cached !== current) {
        void useSettingsStore.getState().saveSettings({ user_avatar_data_url: cached });
      }
    } else if (current) {
      map[uid] = current;
      writeAvatarCache(map);
    }
  });
}
