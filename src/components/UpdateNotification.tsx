import { useUpdateStore } from '../store/useUpdateStore';
import './UpdateNotification.css';

export default function UpdateNotification() {
  const { status, applyUpdate } = useUpdateStore();

  if (!status.updateAvailable) return null;

  const progress = status.contentLength > 0
    ? Math.round((status.downloaded / status.contentLength) * 100)
    : 0;

  return (
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
          <button className="update-notif-btn" onClick={applyUpdate}>立即更新</button>
          <button className="update-notif-dismiss" onClick={() => useUpdateStore.getState().reset()}>稍后</button>
        </div>
      )}
    </div>
  );
}
