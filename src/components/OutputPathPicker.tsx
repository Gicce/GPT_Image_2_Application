import { useEffect } from 'react';
import { api } from '../services/api';
import { useSettingsStore } from '../store/useSettingsStore';
import { useGalleryFolderStore } from '../store/useGalleryFolderStore';
import './OutputPathPicker.css';

const DEFAULT_OPTION = '__default__';
const CUSTOM_OPTION = '__custom__';

function dirBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

/**
 * 全库唯一「输出位置选择器」（V6.6，ADR-029）：
 * 下拉 = 默认路径 + 图片库自定义文件夹（当前值不在其中时兜底显示「自定义：目录名」），
 * 浏览按钮保留系统目录选择。生成入口统一用它决定 output_dir——
 * 未选文件夹时 value 即 settings.default_output_dir（默认路径下生成），
 * 空目录校验仍由 create_task 前端提交链兜底，本组件不发明第二套默认值。
 */
export default function OutputPathPicker(props: { value: string; onChange: (dir: string) => void; label?: string }) {
  const defaultDir = useSettingsStore(s => s.settings.default_output_dir) || '';
  const folders = useGalleryFolderStore(s => s.folders);
  const loadFolders = useGalleryFolderStore(s => s.loadFolders);
  useEffect(() => { void loadFolders(); }, [loadFolders]);

  const matchedFolder = folders.find(folder => folder.path === props.value);
  const isDefault = !matchedFolder && props.value === defaultDir;
  const isCustom = !matchedFolder && !isDefault && !!props.value.trim();
  const selectValue = matchedFolder ? matchedFolder.id : isCustom ? CUSTOM_OPTION : DEFAULT_OPTION;

  async function browse() {
    const dir = await api.selectDirectory();
    if (dir) props.onChange(dir);
  }

  return (
    <div className="output-path-picker">
      <select
        className="output-path-select"
        value={selectValue}
        aria-label={props.label || '输出位置'}
        title="输出位置：图片库文件夹或默认路径"
        onChange={e => {
          const next = e.target.value;
          if (next === DEFAULT_OPTION) {
            props.onChange(defaultDir);
            return;
          }
          const hit = folders.find(folder => folder.id === next);
          if (hit) props.onChange(hit.path);
        }}
      >
        <option value={DEFAULT_OPTION}>默认路径{defaultDir ? '' : '（未配置）'}</option>
        {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        {isCustom && <option value={CUSTOM_OPTION}>自定义：{dirBasename(props.value)}</option>}
      </select>
      <input className="output-path-value" value={props.value} readOnly placeholder="选择图片保存位置" title={props.value} />
      <button type="button" className="app-btn app-btn-secondary" onClick={() => void browse()}>浏览</button>
    </div>
  );
}
