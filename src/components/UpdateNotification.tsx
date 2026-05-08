import { useUpdateStore } from '../store/useUpdateStore';
import './UpdateNotification.css';

export default function UpdateNotification() {
  const { status, applyUpdate, openChangelog, closeChangelog, reset } = useUpdateStore();

  const progress = status.contentLength > 0
    ? Math.round((status.downloaded / status.contentLength) * 100)
    : 0;

  return (
    <>
      {status.updateAvailable && (
        <div className="update-notification">
          {status.downloading ? (
            <div className="update-notif-downloading">
              <span>正在下载更新 v{status.updateInfo?.version}... {progress}%</span>
              <div className="update-notif-progress">
                <div className="update-notif-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          ) : status.installing ? (
            <span>正在安装更新，应用将自动重启...</span>
          ) : (
            <div className="update-notif-available">
              <span>发现新版本 v{status.updateInfo?.version}</span>
              <button className="update-notif-log-btn" onClick={openChangelog}>查看更新日志</button>
              <button className="update-notif-btn" onClick={applyUpdate}>立即更新</button>
              <button className="update-notif-dismiss" onClick={reset}>稍后</button>
            </div>
          )}
        </div>
      )}

      {status.showChangelog && (
        <div className="changelog-overlay" onClick={closeChangelog}>
          <div className="changelog-modal" onClick={e => e.stopPropagation()}>
            <div className="changelog-header">
              <span className="changelog-title">更新日志</span>
              <button className="changelog-close" onClick={closeChangelog}>✕</button>
            </div>
            <div className="changelog-body">
              {status.recentReleases.length === 0 ? (
                <p className="changelog-empty">暂无更新日志</p>
              ) : (
                status.recentReleases.map((r, i) => (
                  <div key={r.version} className={`changelog-release ${i === 0 ? 'changelog-release--latest' : ''}`}>
                    <div className="changelog-release-header">
                      <span className="changelog-version">v{r.version}</span>
                      {i === 0 && <span className="changelog-badge">最新</span>}
                      {r.date && <span className="changelog-date">{r.date}</span>}
                    </div>
                    <div className="changelog-notes">
                      {r.notes
                        ? r.notes.split('\n').filter(l => l.trim()).map((line, j) => (
                            <p key={j} className="changelog-line">{line.replace(/^[-*]\s*/, '• ')}</p>
                          ))
                        : <p className="changelog-empty">暂无说明</p>
                      }
                    </div>
                  </div>
                ))
              )}
            </div>
            {status.updateAvailable && (
              <div className="changelog-footer">
                <button className="update-notif-btn changelog-update-btn" onClick={applyUpdate}>
                  立即更新到 v{status.updateInfo?.version}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
