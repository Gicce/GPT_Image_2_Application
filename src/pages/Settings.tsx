import { useEffect, useState, useRef } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import './Settings.css';

export default function Settings() {
  const { settings, loadSettings, saveSettings } = useSettingsStore();
  const [savedKeys, setSavedKeys] = useState<Record<string, boolean>>({});
  const timersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(t => clearTimeout(t));
    };
  }, []);

  function save(partial: Partial<typeof settings>) {
    saveSettings(partial);
    Object.keys(partial).forEach(key => {
      setSavedKeys(s => ({ ...s, [key]: true }));
      if (timersRef.current[key]) clearTimeout(timersRef.current[key]);
      timersRef.current[key] = setTimeout(() => {
        setSavedKeys(s => ({ ...s, [key]: false }));
      }, 1500);
    });
  }

  const handleSelectDir = async () => {
    const dir = await api.selectDirectory();
    if (dir) save({ default_output_dir: dir });
  };

  const SavedTip = ({ k }: { k: string }) =>
    savedKeys[k] ? <span className="saved-tip">✓ 已保存</span> : null;

  return (
    <div className="page">
      <div className="page-header">
        <h2>设置</h2>
        <p>配置默认生成参数。Token 由账户自动同步，无需手填。</p>
      </div>

      <div className="settings-form">
        <div className="form-row">
          <div className="form-group">
            <label>默认图片尺寸</label>
            <select
              value={settings.default_size}
              onChange={e => save({ default_size: e.target.value })}
            >
              {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>默认质量</label>
            <select
              value={settings.default_quality}
              onChange={e => save({ default_quality: e.target.value })}
            >
              {QUALITIES.map(q => <option key={q} value={q}>{QUALITY_LABELS[q] || q}</option>)}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>默认输出格式</label>
            <select
              value={settings.default_format}
              onChange={e => save({ default_format: e.target.value })}
            >
              {FORMATS.map(f => <option key={f} value={f}>{f.toUpperCase()}</option>)}
            </select>
          </div>
          <div className="form-group" />
        </div>

        <div className="form-group">
          <label>默认输出目录</label>
          <div className="dir-input">
            <input
              type="text"
              value={settings.default_output_dir}
              onChange={e => save({ default_output_dir: e.target.value })}
              placeholder="选择默认保存位置"
              readOnly
            />
            <button className="browse-btn" onClick={handleSelectDir}>浏览</button>
          </div>
        </div>

        <div className="save-note">
          <p>所有设置自动保存到本地。</p>
        </div>

        <h3 className="settings-section-title">外观</h3>
        <div className="form-group">
          <label>主题模式</label>
          <div className="theme-picker">
            {(['light', 'dark', 'system'] as const).map(v => (
              <button
                key={v}
                className={`theme-picker-btn ${settings.theme === v ? 'active' : ''}`}
                onClick={() => save({ theme: v })}
              >
                {v === 'light' ? '☀️ 浅色' : v === 'dark' ? '🌙 深色' : '💻 系统'}
              </button>
            ))}
          </div>
          <p className="form-hint">选择「系统」将跟随操作系统的深色/浅色设置自动切换。</p>
        </div>

        <h3 className="settings-section-title">智能对话设置</h3>

        <div className="form-row">
          <div className="form-group">
            <label>对话模型</label>
            <div className="readonly-field">{settings.chat_model || '未选择'}</div>
            <p className="form-hint">在「智能对话」页发送框下方切换模型。</p>
          </div>
          <div className="form-group">
            <div className="label-row">
              <label>对话 Base URL</label>
              <SavedTip k="chat_base_url" />
            </div>
            <input
              type="text"
              value={settings.chat_base_url}
              onChange={e => save({ chat_base_url: e.target.value })}
              placeholder="https://www.packyapi.com/v1"
            />
          </div>
        </div>

        <div className="form-group">
          <div className="label-row">
            <label>System Prompt（可选）</label>
            <SavedTip k="chat_system_prompt" />
          </div>
          <input
            type="text"
            value={settings.chat_system_prompt}
            onChange={e => save({ chat_system_prompt: e.target.value })}
            placeholder="You are a helpful assistant."
          />
        </div>

        <h3 className="settings-section-title">其他</h3>

        <div className="form-group">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.notice_enabled ?? true}
              onChange={e => save({ notice_enabled: e.target.checked })}
            />
            <span>显示顶部跑马灯通知栏</span>
          </label>
          <p className="form-hint">
            取消勾选后，顶部公告通知不再显示。
          </p>
        </div>
      </div>
    </div>
  );
}
