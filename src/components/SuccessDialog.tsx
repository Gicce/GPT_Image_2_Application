import './SuccessDialog.css';

interface Props {
  title: string;
  message: string;
  onClose: () => void;
}

export default function SuccessDialog({ title, message, onClose }: Props) {
  return (
    <div className="sd-overlay" onClick={onClose}>
      <div className="sd-dialog" onClick={e => e.stopPropagation()}>
        <div className="sd-icon-row">
          <div className="sd-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5l-4-4 1.41-1.41L10 13.67l6.59-6.59L18 8.5l-8 8z" fill="currentColor"/>
            </svg>
          </div>
        </div>
        <div className="sd-content">
          <h3 className="sd-title">{title}</h3>
          <p className="sd-message">{message}</p>
        </div>
        <div className="sd-actions">
          <button className="sd-btn sd-btn-ok" onClick={onClose}>确定</button>
        </div>
      </div>
    </div>
  );
}
