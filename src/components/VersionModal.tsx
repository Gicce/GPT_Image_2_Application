import { useState } from 'react';
import { useUpdateStore } from '../store/useUpdateStore';
import './VersionModal.css';

const CHANGELOG: Record<string, string> = {
  '1.0.3': `- 批量文生图（GPT Image 2）
- 批量图生图/编辑图片
- 智能对话（支持文生图、图生图）
- 深度思考模式
- 图片库管理
- 任务队列
- 历史记录`,
};

export default function VersionModal({ version, onClose }: { version: string; onClose: () => void }) {
  const { status, checkUpdate, applyUpdate } = useUpdateStore();
  const [checked, setChecked] = useState(false);
  const cleanVersion = version.replace(/^v/, '');
  const notes = CHANGELOG[cleanVersion] || '暂无更新日志。';

  const handleCheck = async () => {
    await checkUpdate();
    setChecked(true);
  };

  const progress = status.contentLength > 0
    ? Math.round((status.downloaded / status.contentLength) * 100)
    : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="version-modal" onClick={e => e.stopPropagation()}>
        <div className="version-modal-header">
          <h3>CyImagePro {version}</h3>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>
        <div className="version-modal-body">
          <h4>更新日志</h4>
          <pre className="changelog-text">{notes}</pre>

          {status.error && (
            <div className="update-error">{status.error}</div>
          )}

          {status.downloading && (
            <div className="update-progress">
              <span>正在下载更新 v{status.updateInfo?.version}... {progress}%</span>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status.installing && (
            <div className="update-installing">正在安装更新，应用将自动重启...</div>
          )}

          {checked && !status.updateAvailable && !status.error && !status.downloading && (
            <div className="update-uptodate">当前已是最新版本</div>
          )}

          {status.updateAvailable && !status.downloading && !status.installing && (
            <div className="update-available">
              <p>发现新版本 v{status.updateInfo?.version}</p>
              {status.updateInfo?.body && (
                <pre className="update-notes">{status.updateInfo.body}</pre>
              )}
              <button className="btn-update-now" onClick={applyUpdate}>立即更新</button>
            </div>
          )}
        </div>
        <div className="version-modal-footer">
          {!status.updateAvailable && !status.downloading && !status.installing && (
            <button className="btn-check-update" onClick={handleCheck} disabled={status.checking}>
              {status.checking ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
