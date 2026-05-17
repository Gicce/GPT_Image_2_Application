import './DeleteConvDialog.css';

interface Props {
  convTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DeleteConvDialog({ convTitle, onConfirm, onCancel }: Props) {
  return (
    <div className="dcd-overlay" onClick={onCancel}>
      <div className="dcd-dialog" onClick={e => e.stopPropagation()}>
        <div className="dcd-icon-row">
          <div className="dcd-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="currentColor"/>
            </svg>
          </div>
        </div>
        <div className="dcd-content">
          <h3 className="dcd-title">删除对话</h3>
          <p className="dcd-desc">确定要删除此对话吗？此操作无法撤销。</p>
          <p className="dcd-conv-name">"{convTitle.length > 40 ? convTitle.slice(0, 40) + '...' : convTitle}"</p>
        </div>
        <div className="dcd-actions">
          <button className="dcd-btn dcd-btn-cancel" onClick={onCancel}>取消</button>
          <button className="dcd-btn dcd-btn-delete" onClick={onConfirm}>删除</button>
        </div>
      </div>
    </div>
  );
}