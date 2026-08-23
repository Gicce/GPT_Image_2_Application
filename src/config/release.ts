/**
 * 发布信息（单一来源）。
 * version 需与 package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml 保持一致；
 * 发布阶段（channel/iteration/label）独立于底层 SemVer，不写入 Tauri/Cargo version 字段。
 */
export const RELEASE_INFO = {
  version: '4.0.9',
  channel: 'stable',
  iteration: 1,
  label: '正式版',
} as const;

export type ReleaseChannel = typeof RELEASE_INFO.channel;
