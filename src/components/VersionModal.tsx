import { useEffect } from 'react';
import { useUpdateStore } from '../store/useUpdateStore';
import { isNewerVersion } from '../utils/version';
import './VersionModal.css';

export default function VersionModal({ version, onClose }: { version: string; onClose: () => void }) {
  const { status, checkUpdate, applyUpdate, installAndRestart } = useUpdateStore();

  useEffect(() => {
    // 已检查过则不重复请求；检查逻辑与设置页/启动检查共用同一 store
    void checkUpdate();
  }, []);

  const installedVersion = version.replace(/^V/, '');
  const progress = status.contentLength > 0
    ? Math.round((status.downloaded / status.contentLength) * 100)
    : 0;

  // 情况 D：updater 正常响应且确认无更高版本，但 changelog 顶部版本号更高
  // （更新日志已发布、安装包尚未开放下载），此时提示用户而不是误报“已是最新”。
  const changelogNewer = status.phase === 'latest'
    && status.recentReleases.length > 0
    && installedVersion !== ''
    && isNewerVersion(status.recentReleases[0].version, installedVersion);

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
            <span className="version-current-value">{version || '读取中...'}</span>
          </div>

          {/* 更新状态区（互斥） */}
          {status.phase === 'checking' && (
            <div className="update-checking">正在检查更新...</div>
          )}

          {status.phase === 'update_available' && (
            <div className="update-available">
              <span className="update-available-text">发现新版本 v{status.latestVersion}</span>
              {status.error && <div className="update-error">{status.error}</div>}
              <div className="update-version-row">
                <span className="update-version-item">当前版本 v{installedVersion}</span>
                <span className="update-version-item update-version-item--new">最新版本 v{status.latestVersion}</span>
              </div>
              <button className="btn-update-now" onClick={() => void applyUpdate()}>立即更新</button>
            </div>
          )}

          {status.phase === 'download_failed' && (
            <div className="update-available">
              <span className="update-available-text">发现新版本 v{status.latestVersion}</span>
              <div className="update-error">{status.error ?? '更新下载失败，请检查网络后重试。'}</div>
              <div className="update-version-row">
                <span className="update-version-item">当前版本 v{installedVersion}</span>
                <span className="update-version-item update-version-item--new">最新版本 v{status.latestVersion}</span>
              </div>
              <button className="btn-update-now" onClick={() => void applyUpdate()}>重试更新</button>
            </div>
          )}

          {status.phase === 'downloading' && (
            <div className="update-progress">
              <span>正在下载更新 v{status.latestVersion}... {progress}%</span>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
            </div>
          )}

          {status.phase === 'restart_required' && (
            <div className="update-restart-required">
              <div className="update-restart-text">
                更新 v{status.latestVersion} 已下载完成，需要重启 CyImagePro 完成安装。
              </div>
              <div className="update-restart-actions">
                <button className="btn-update-now" onClick={() => void installAndRestart()}>立即重启并更新</button>
                <button className="btn-update-later" onClick={onClose}>稍后</button>
              </div>
            </div>
          )}

          {status.phase === 'installing' && (
            <div className="update-installing">正在安装更新，应用将自动重启...</div>
          )}

          {status.phase === 'latest' && !changelogNewer && (
            <div className="version-up-to-date">✓ 当前已是最新版本</div>
          )}

          {status.phase === 'latest' && changelogNewer && (
            <div className="update-release-pending">
              v{status.recentReleases[0].version} 更新日志已发布，安装包暂未开放下载。
            </div>
          )}

          {status.phase === 'check_failed' && (
            <div className="update-check-failed">
              <div className="update-error">{status.error ?? '无法获取最新版本信息，请检查网络后重试。'}</div>
              <button className="btn-check-update" onClick={() => void checkUpdate(true)}>重新检查</button>
            </div>
          )}

          {(status.phase === 'idle') && (
            <div className="update-checking">准备检查更新...</div>
          )}

          {/* 更新日志 */}
          <h4 className="changelog-section-title">更新日志</h4>

          {status.recentReleases.length === 0 ? (
            <div className="changelog-empty-tip">
              {status.phase === 'check_failed' ? '更新日志暂不可用' : '暂无更新日志'}
            </div>
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
                      : <p className="cl-line-empty">暂无说明</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="version-modal-footer">
          {status.phase !== 'downloading' && status.phase !== 'installing' && status.phase !== 'restart_required'
            && status.phase !== 'check_failed' && status.phase !== 'download_failed' && (
            <button className="btn-check-update" onClick={() => void checkUpdate(true)} disabled={status.phase === 'checking'}>
              {status.phase === 'checking' ? '检查中...' : '检查更新'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
