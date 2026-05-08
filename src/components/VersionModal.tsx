import { useEffect } from 'react';
import { useUpdateStore } from '../store/useUpdateStore';
import './VersionModal.css';

export default function VersionModal({ version, onClose }: { version: string; onClose: () => void }) {
  const { status, checkUpdate, applyUpdate } = useUpdateStore();

  useEffect(() => {
    // 每次打开弹窗都重新检查，确保状态最新
    checkUpdate();
  }, []);

  const progress = status.contentLength > 0
    ? Math.round((status.downloaded / status.contentLength) * 100)
    : 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="version-modal" onClick={e => e.stopPropagation()}>
        <div className="version-modal-header">
          <h3>CyImagePro</h3>
          <button className="modal-close-btn" onClick={onClose}>&times;</button>
        </div>

        <div className="version-modal-body">
          {/* 当前版本 */}
          <div className="version-current-row">
            <span className="version-current-label">当前版本</span>
            <span className="version-current-value">{version}</span>
          </div>

          {/* 更新状态区 */}
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

          {status.updateAvailable && !status.downloading && !status.installing && (
            <div className="update-available">
              <span className="update-available-text">发现新版本 v{status.updateInfo?.version}</span>
              <button className="btn-update-now" onClick={applyUpdate}>立即更新</button>
            </div>
          )}

          {!status.updateAvailable && !status.checking && !status.downloading && !status.installing && (
            <div className="version-up-to-date">当前已是最新版本</div>
          )}

          {status.error && (
            <div className="update-error">{status.error}</div>
          )}

          {/* 更新日志 */}
          <h4 className="changelog-section-title">更新日志</h4>

          {status.checking && status.recentReleases.length === 0 ? (
            <div className="changelog-loading">加载中...</div>
          ) : status.recentReleases.length === 0 ? (
            <div className="changelog-empty-tip">暂无更新日志</div>
          ) : (
            <div className="changelog-list">
              {status.recentReleases.map((r, i) => (
                <div key={r.version} className={`cl-release ${i === 0 ? 'cl-release--latest' : ''}`}>
                  <div className="cl-release-header">
                    <span className="cl-version">v{r.version}</span>
                    {i === 0 && <span className="cl-badge">最新</span>}
                    {r.date && <span className="cl-date">{r.date}</span>}
                  </div>
                  <div className="cl-notes">
                    {r.notes
                      ? r.notes.split('\n').filter(l => l.trim()).map((line, j) => (
                          <p key={j} className="cl-line">{line.replace(/^[-*]\s*/, '• ')}</p>
                        ))
                      : <p className="cl-line-empty">暂无说明</p>
                    }
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="version-modal-footer">
          {!status.downloading && !status.installing && (
            <button className="btn-check-update" onClick={checkUpdate} disabled={status.checking}>
              {status.checking ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
