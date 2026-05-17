import { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { serverApi } from '../services/serverApi';
import { explainError } from '../utils/errors';
import './Auth.css';

interface Props {
  onSuccess: () => void;
  onClose?: () => void;
}

export default function Auth({ onSuccess, onClose }: Props) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [regType, setRegType] = useState<'trial' | 'normal'>('trial');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [trialStock, setTrialStock] = useState<{ count: number; available: boolean } | null>(null);
  const [stockLoading, setStockLoading] = useState(false);

  // 注册验证码相关状态
  const [regStep, setRegStep] = useState<1 | 2>(1);
  const [regCode, setRegCode] = useState('');
  const [countdown, setCountdown] = useState(0);

  // 忘记密码相关状态
  const [forgotStep, setForgotStep] = useState<1 | 2>(1);
  const [forgotEmail, setForgotEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [forgotSuccess, setForgotSuccess] = useState('');

  const { login, registerSendCode, registerVerify } = useAuthStore();

  // 倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => setCountdown(c => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // 切到注册 tab 时拉取试用库存
  useEffect(() => {
    if (mode === 'register') {
      setStockLoading(true);
      serverApi.getTrialStock()
        .then(data => {
          const count = data.remaining ?? 0;
          const available = data.available ?? count > 0;
          setTrialStock({ count, available });
          if (!available) setRegType('normal');
        })
        .catch(() => setTrialStock(null))
        .finally(() => setStockLoading(false));
    }
  }, [mode]);

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(username, password);
      onSuccess();
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await registerSendCode(username, email, password, regType);
      setRegStep(2);
      setCountdown(60);
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleRegVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await registerVerify(email, regCode, username, password, regType);
      onSuccess();
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleForgotSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await serverApi.forgotPassword(forgotEmail);
      setForgotStep(2);
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await serverApi.resetPassword(forgotEmail, verifyCode, newPassword);
      setForgotSuccess('密码重置成功，请登录');
    } catch (e: any) {
      setError(explainError(e));
    } finally {
      setLoading(false);
    }
  }

  function switchToLogin() {
    setMode('login');
    setError('');
    setRegStep(1);
    setRegCode('');
    setCountdown(0);
    setForgotStep(1);
    setForgotSuccess('');
    setForgotEmail('');
    setVerifyCode('');
    setNewPassword('');
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
          <button className={`auth-tab ${mode === 'login' || mode === 'forgot' ? 'active' : ''}`}
            onClick={switchToLogin}>登录</button>
          <button className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
            onClick={() => { setMode('register'); setError(''); setRegStep(1); }}>注册</button>
        </div>

        {/* ====== 忘记密码模式 ====== */}
        {mode === 'forgot' && (
          forgotSuccess ? (
            <div className="auth-forgot-success">
              <span className="auth-forgot-success-icon">✅</span>
              <p>{forgotSuccess}</p>
              <button className="auth-submit" onClick={switchToLogin}>返回登录</button>
            </div>
          ) : forgotStep === 1 ? (
            <form className="auth-form" onSubmit={handleForgotSendCode}>
              <p className="auth-forgot-hint">输入注册时使用的邮箱，我们将发送验证码到您的邮箱。</p>
              <div className="auth-field">
                <label>邮箱</label>
                <input type="email" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)}
                  placeholder="输入注册邮箱" required autoFocus />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button className="auth-submit" type="submit" disabled={loading}>
                {loading ? '请稍候...' : '发送验证码'}
              </button>
              <button type="button" className="auth-back-link" onClick={switchToLogin}>← 返回登录</button>
            </form>
          ) : (
            <form className="auth-form" onSubmit={handleResetPassword}>
              <p className="auth-forgot-hint">验证码已发送至 <strong>{forgotEmail}</strong></p>
              <div className="auth-field">
                <label>验证码</label>
                <input type="text" value={verifyCode} onChange={e => setVerifyCode(e.target.value)}
                  placeholder="输入验证码" required autoFocus />
              </div>
              <div className="auth-field">
                <label>新密码</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                  placeholder="输入新密码" required minLength={6} />
              </div>
              {error && <div className="auth-error">{error}</div>}
              <button className="auth-submit" type="submit" disabled={loading}>
                {loading ? '请稍候...' : '重置密码'}
              </button>
              <button type="button" className="auth-back-link" onClick={() => { setForgotStep(1); setError(''); }}>← 重新发送验证码</button>
            </form>
          )
        )}

        {/* ====== 注册类型选择 ====== */}
        {mode === 'register' && (
          <div className="reg-type-group">
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

            <button
              type="button"
              className={`reg-type-btn ${regType === 'normal' ? 'active' : ''}`}
              onClick={() => setRegType('normal')}
            >
              <span className="reg-type-icon">✅</span>
              <span className="reg-type-info">
                <span className="reg-type-name">普通账号</span>
                <span className="reg-type-desc">永久有效 · 注册后充值使用</span>
              </span>
            </button>
          </div>
        )}

        {/* ====== 登录表单 ====== */}
        {mode === 'login' && (
          <form className="auth-form" onSubmit={handleLoginSubmit}>
            <div className="auth-field">
              <label>用户名</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="输入用户名" required autoFocus />
            </div>
            <div className="auth-field">
              <label>密码</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="输入密码" required />
            </div>
            <button type="button" className="auth-forgot-link"
              onClick={() => { setMode('forgot'); setError(''); setForgotStep(1); setForgotSuccess(''); }}>
              忘记密码？
            </button>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? '请稍候...' : '登录'}
            </button>
          </form>
        )}

        {/* ====== 注册步骤1：填写信息 + 获取验证码 ====== */}
        {mode === 'register' && regStep === 1 && (
          <form className="auth-form" onSubmit={handleRegSendCode}>
            <div className="auth-field">
              <label>用户名</label>
              <input type="text" value={username} onChange={e => setUsername(e.target.value)}
                placeholder="输入用户名" required autoFocus />
            </div>
            <div className="auth-field">
              <label>邮箱</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="输入邮箱" required />
            </div>
            <div className="auth-field">
              <label>密码</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                placeholder="输入密码" required />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? '请稍候...' : '获取验证码'}
            </button>
          </form>
        )}

        {/* ====== 注册步骤2：输入验证码完成注册 ====== */}
        {mode === 'register' && regStep === 2 && (
          <form className="auth-form" onSubmit={handleRegVerify}>
            <p className="auth-verify-hint">验证码已发送至 <strong>{email}</strong></p>
            <div className="auth-field">
              <label>验证码</label>
              <div className="auth-code-row">
                <input type="text" value={regCode} onChange={e => setRegCode(e.target.value)}
                  placeholder="输入验证码" required autoFocus />
                <button type="button" disabled={countdown > 0 || loading}
                  onClick={handleRegSendCode}>
                  {countdown > 0 ? `${countdown}s` : '重新发送'}
                </button>
              </div>
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button className="auth-submit" type="submit" disabled={loading}>
              {loading ? '请稍候...' : '注册'}
            </button>
            <button type="button" className="auth-back-link"
              onClick={() => { setRegStep(1); setError(''); }}>
              ← 修改注册信息
            </button>
          </form>
        )}

      </div>
    </div>
  );
}