import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { serverApi } from '../services/serverApi';
import './Auth.css';

interface Props {
  onSuccess: () => void;
  onClose?: () => void;
}

export default function Auth({ onSuccess, onClose }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [regType, setRegType] = useState<'trial' | 'paid'>('trial');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [trialStock, setTrialStock] = useState<{ count: number; available: boolean } | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  const { login, register } = useAuthStore();
  const serverUrl = useSettingsStore(s => s.settings.server_url);

  // 切到注册 tab 时拉取试用库存
  useEffect(() => {
    if (mode === 'register' && serverUrl) {
      setStockLoading(true);
      serverApi.getTrialStock()
        .then(data => {
          const count = data.remaining ?? 0;
          const available = data.available ?? count > 0;
          setTrialStock({ count, available });
          if (!available) setRegType('paid');
        })
        .catch(() => setTrialStock(null))
        .finally(() => setStockLoading(false));
    }
  }, [mode, serverUrl]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!serverUrl) { setError('请先在「设置」页填写服务器地址'); return; }
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register(username, email, password, regType);
      }
      onSuccess();
    } catch (e: any) {
      setError(e.message || '操作失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  const trialAvailable = trialStock?.available ?? true;

  return (
    <div className="auth-overlay">
      <div className="auth-card">
        {onClose && (
          <button className="auth-close" onClick={onClose} title="关闭">×</button>
        )}
        <div className="auth-logo">CyImagePro</div>

        {/* 登录 / 注册 tab */}
        <div className="auth-tabs">
          <button className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
            onClick={() => { setMode('login'); setError(''); }}>登录</button>
          <button className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => { setMode('register'); setError(''); }}>注册</button>
        </div>

        {/* 注册类型选择 */}
        {mode === 'register' && (
          <div className="reg-type-group">
            {/* 试用账号 */}
            <button
              type="button"
              className={`reg-type-btn ${regType === 'trial' ? 'active' : ''} ${!trialAvailable ? 'disabled' : ''}`}
              onClick={() => trialAvailable && setRegType('trial')}
              disabled={!trialAvailable}
            >
              <span className="reg-type-icon">
                {stockLoading ? '⏳' : trialAvailable ? '✅' : '⛔'}
              </span>
              <span className="reg-type-info">
                <span className="reg-type-name">试用账号</span>
                <span className="reg-type-desc">
                  {stockLoading
                    ? '查询中...'
                    : trialAvailable
                      ? `剩余 ${trialStock?.count} 个名额 · 2天有效期 · $1余额`
                      : '名额已满，暂不可用'}
                </span>
              </span>
            </button>

            {/* 普通账号 */}
            <button
              type="button"
              className={`reg-type-btn ${regType === 'paid' ? 'active' : ''}`}
              onClick={() => setRegType('paid')}
            >
              <span className="reg-type-icon">✅</span>
              <span className="reg-type-info">
                <span className="reg-type-name">普通账号</span>
                <span className="reg-type-desc">永久有效 · 注册后充值使用</span>
              </span>
            </button>
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="auth-field">
            <label>用户名</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              placeholder="输入用户名" required autoFocus />
          </div>

          {mode === 'register' && (
            <div className="auth-field">
              <label>邮箱</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="输入邮箱" required />
            </div>
          )}

          <div className="auth-field">
            <label>密码</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              placeholder="输入密码" required />
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button className="auth-submit" type="submit" disabled={loading}>
            {loading ? '请稍候...' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>

        {!serverUrl && (
          <p className="auth-hint">提示：请先在「设置」页配置服务器地址</p>
        )}
      </div>
    </div>
  );
}
