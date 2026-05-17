import { useState } from 'react';
import './DeleteTaskDialog.css';

interface Props {
  taskPrompt: string;
  imageCount: number;
  onConfirm: (deleteImages: boolean) => void;
  onCancel: () => void;
}

export default function DeleteTaskDialog({ taskPrompt, imageCount, onConfirm, onCancel }: Props) {
  const [deleteImages, setDeleteImages] = useState(false);

  return (
    <div className="dtd-overlay" onClick={onCancel}>
      <div className="dtd-dialog" onClick={e => e.stopPropagation()}>
        <div className="dtd-icon-row">
          <div className="dtd-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>
            </svg>
          </div>
        </div>

        <div className="dtd-content">
          <h3 className="dtd-title">删除任务</h3>
          <p className="dtd-desc">
            确定要删除此任务吗？此操作无法撤销。
          </p>
          <p className="dtd-prompt">"{taskPrompt.length > 60 ? taskPrompt.slice(0, 60) + '…' : taskPrompt}"</p>

          {imageCount > 0 && (
            <label className="dtd-checkbox-row">
              <input
                type="checkbox"
                className="dtd-checkbox"
                checked={deleteImages}
                onChange={e => setDeleteImages(e.target.checked)}
              />
              <span className="dtd-checkbox-label">
                同时删除关联的 {imageCount} 张生成图片
              </span>
            </label>
          )}
        </div>

        <div className="dtd-actions">
          <button className="dtd-btn dtd-btn-cancel" onClick={onCancel}>取消</button>
          <button className="dtd-btn dtd-btn-delete" onClick={() => onConfirm(deleteImages)}>删除</button>
        </div>
      </div>
    </div>
  );
}
