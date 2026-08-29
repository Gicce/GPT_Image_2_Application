/**
 * 图库条目唯一身份（Gallery Identity）。
 *
 * 历史问题：同一真实文件在索引里出现两条记录（目录重叠重复扫描 / 路径分隔符
 * 或大小写差异），导致"全部"视图同一图片显示两次；且图库选择器的选中态按
 * `att.filePath === img.local_path` 判断 —— 两条同 path 记录会同时绿框，
 * 而"已选择 N 张"只计 1 张。
 *
 * 本模块提供 display model 层的确定性身份：
 *   - normalizeGalleryPath：统一分隔符 / 去尾斜杠 / 解析 . 与 .. /
 *     Windows 盘符路径大小写归一（`D:\Images\a.png` ≡ `d:/images/a.png`）。
 *   - dedupeGalleryItems：按 normalized path 去重，保留传入顺序中的第一条
 *     （调用方通常已按最新优先排序，即保留最新记录）。
 *
 * 去重策略（与产品约定一致）：
 *   - 同 normalized path → 必须合并为一条。
 *   - 不同路径、即使文件名相同甚至内容相同 → 保留两条（它们是独立文件）。
 */

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

/** 统一图库路径身份键。入参允许 undefined / 空串（返回空 key）。 */
export function normalizeGalleryPath(path: string | undefined | null): string {
  let p = (path || '').trim().replace(/\\/g, '/');
  // 解析路径段中的 . 与 ..
  const segments: string[] = [];
  let prefix = '';
  const driveMatch = p.match(WINDOWS_DRIVE_PATH);
  if (driveMatch) {
    prefix = driveMatch[0].replace(/\/$/, '').toLowerCase() + '/';
    p = p.slice(driveMatch[0].length);
  } else if (p.startsWith('/')) {
    prefix = '/';
    p = p.slice(1);
  }
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      segments.pop();
      continue;
    }
    segments.push(seg);
  }
  let normalized = prefix + segments.join('/');
  // Windows 盘符路径大小写不敏感 —— 归一成小写比较。
  // UNC 路径（//server/share）同样按 Windows 语义处理。
  if (prefix === '/' && normalized.startsWith('//')) {
    normalized = normalized.toLowerCase();
  } else if (driveMatch) {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/**
 * 按 normalized local_path 去重图库条目。
 * 输入应已展示顺序（如最新优先）排序；同 path 保留第一条。
 */
export function dedupeGalleryItems<T extends { local_path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = normalizeGalleryPath(item.local_path || '');
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/**
 * 图库自定义文件夹归属（V6.6，ADR-029）：图片 local_path 的归一化前缀
 * 落在文件夹 path 之下即属于该文件夹。folderPath 为空（全部文件夹）恒真。
 * 复用 normalizeGalleryPath 的分隔符 / 盘符大小写归一，与 Rust 端
 * normalize_image_path_key 同规则，避免 Windows 双写形态漏判。
 */
export function matchesGalleryFolder(localPath: string | undefined | null, folderPath: string | undefined | null): boolean {
  const folder = normalizeGalleryPath(folderPath);
  if (!folder) return true;
  const file = normalizeGalleryPath(localPath);
  if (!file) return false;
  return file === folder || file.startsWith(`${folder}/`);
}
