/**
 * 图片二进制复制到系统剪贴板（内置 ImageViewer「复制图片」唯一实现）。
 * 必须复制真实图片二进制（ClipboardItem），绝不只复制路径 / URL。
 * data URL → fetch blob 优先；WebView 拒绝 fetch 时回落 canvas 重绘。
 */

export async function copyImageBinaryToClipboard(src: string): Promise<boolean> {
  try {
    const blob = await fetchBlob(src);
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      return true;
    }
  } catch {
    // 走 canvas 回落
  }
  try {
    const blob = await redrawViaCanvas(src);
    if (blob) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
  } catch {
    // 回落也失败
  }
  return false;
}

async function fetchBlob(src: string): Promise<Blob | null> {
  try {
    const resp = await fetch(src);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return blob.type.startsWith('image/') ? blob : null;
  } catch {
    return null;
  }
}

function redrawViaCanvas(src: string): Promise<Blob | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onerror = () => resolve(null);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0);
      canvas.toBlob(blob => resolve(blob), 'image/png');
    };
    img.src = src;
  });
}
