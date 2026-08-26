import React, { useState, useEffect } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useServerStatusStore } from '../store/useServerStatusStore';
import { serverApi } from '../services/serverApi';
import { explainError } from '../utils/errors';
import './Auth.css';

interface Props {
  onSuccess: () => void;
  onClose?: () => void;
}

export default function Auth({ onSuccess, onClose }: Props) {
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [regType, setRegType] = useState<'trial' | 'normal'>('normal'); // 默认改为普通账号
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [trialStock, setTrialStock] = useState<{
    available: boolean;
    reason: string;
    grant_credits: number;
    valid_days: number;
    campaign_version: number;
  } | null>(null);
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
  const { connectionStatus, checkConnection } = useServerStatusStore();
  const { settings } = useSettingsStore();

  // Connection status display - hide server address, only show status
  const connectionStatusDisplay = React.useMemo(() => {
    if (connectionStatus === 'connected') {
      return { icon: '🟢', text: '已连接服务器', canSubmit: true };
    }
    if (connectionStatus === 'connecting') {
      return { icon: '🟡', text: '正在连接服务器...', canSubmit: false };
    }
    return { icon: '🔴', text: '无法连接服务器，请前往「设置与更新 → 服务连接」检查服务器连接', canSubmit: false };
  }, [connectionStatus]);

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
          const available = data.available ?? (data.remaining ?? 0) > 0;
          setTrialStock({
            available,
            reason: data.reason || (available ? 'ok' : 'trial_token_unavailable'),
            grant_credits: data.grant_credits ?? 0,
            valid_days: data.valid_days ?? 0,
            campaign_version: data.campaign_version ?? 0,
          });
          if (!available) setRegType('normal');
        })
        .catch(() => setTrialStock(null))
        .finally(() => setStockLoading(false));
    }
  }, [mode]);

  async function handleLoginSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    // Check connection status first
    if (connectionStatus !== 'connected') {
      // Try to reconnect once
      const connected = await checkConnection();
      if (!connected) {
        setError('无法连接服务器，请前往「设置与更新 → 服务连接」检查服务器连接');
        return;
      }
    }

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

    // Check connection status first
    if (connectionStatus !== 'connected') {
      // Try to reconnect once
      const connected = await checkConnection();
      if (!connected) {
        setError('无法连接服务器，请前往「设置与更新 → 服务连接」检查服务器连接');
        return;
      }
    }

    setLoading(true);

    // [临时诊断] 点击日志
    console.log('[Auth] ===== CLICK GET CODE =====');
    console.log('[Auth] current server_url:', useSettingsStore.getState().settings.server_url);
    console.log('[Auth] regType:', regType);
    console.log('[Auth] email:', email);
    console.log('[Auth] username:', username);
    console.log('[Auth] password length:', password.length);

    try {
      console.log('[Auth] calling registerSendCode...');
      await registerSendCode(username, email, password, regType);
      console.log('[Auth] registerSendCode SUCCESS');
      setRegStep(2);
      setCountdown(60);
    } catch (e: any) {
      console.error('[Auth] registerSendCode FAILED:', e);
      console.error('[Auth] error message:', e.message);
      console.error('[Auth] error status:', e.status);
      console.error('[Auth] error isNetworkError:', e.isNetworkError);
      setError(explainError(e));
    } finally {
      setLoading(false);
      console.log('[Auth] ===== CLICK GET CODE END =====');
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

        {/* 服务器连接状态 - 不显示具体地址 */}
        <div className="auth-server-status">
          <span className={`auth-server-indicator ${connectionStatus}`}>
            {connectionStatusDisplay.icon}
          </span>
          <span className={`auth-server-text ${connectionStatus}`}>
            {connectionStatusDisplay.text}
          </span>
        </div>

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
                      ? `可申请 · ${trialStock?.valid_days ?? 0}天有效 · 赠送${(trialStock?.grant_credits ?? 0).toLocaleString('zh-CN')} CY点`
                      : trialStock?.reason === 'trial_disabled'
                        ? '试用活动暂未开放'
                        : '试用服务暂不可用'}
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
