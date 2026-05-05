import { useEffect } from 'react';
import { useSettingsStore } from '../store/useSettingsStore';
import { api } from '../services/api';
import { SIZES, QUALITIES, QUALITY_LABELS, FORMATS } from '../types';
import './Settings.css';

export default function Settings() {
  const { settings, loadSettings, saveSettings } = useSettingsStore();

  useEffect(() => {
    loadSettings();
  }, []);

  const handleSelectDir = async () => {
    const dir = await api.selectDirectory();
    if (dir) saveSettings({ default_output_dir: dir });
  };

  return (
    <div className="page">
      <div className="page-header">
        <h2>设置</h2>
        <p>配置 API Token 和默认生成参数</p>
      </div>

      <div className="settings-form">
        <div className="form-group">
          <label>API Token</label>
          <input
            type="password"
            value={settings.token}
            onChange={e => saveSettings({ token: e.target.value })}
            placeholder="输入你的 API Token（Sora 分组令牌）"
          />
          <p className="form-hint">
            Token 仅保存在本地，不会上传到任何服务器。格式如：sk-xxx 或自定义令牌。
          </p>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>默认图片尺寸</label>
            <select
              value={settings.default_size}
              onChange={e => saveSettings({ default_size: e.target.value })}
            >
              {SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>默认质量</label>
            <select
              value={settings.default_quality}
              onChange={e => saveSettings({ default_quality: e.target.value })}
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
              onChange={e => saveSettings({ default_format: e.target.value })}
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
              onChange={e => saveSettings({ default_output_dir: e.target.value })}
              placeholder="选择默认保存位置"
              readOnly
            />
            <button className="browse-btn" onClick={handleSelectDir}>浏览</button>
          </div>
        </div>

        <div className="save-note">
          <p>所有设置自动保存到本地。</p>
        </div>
      </div>
    </div>
  );
}
