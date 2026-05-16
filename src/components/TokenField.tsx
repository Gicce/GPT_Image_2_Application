import { useState } from 'react';
import { Command } from '@tauri-apps/plugin-shell';
import './TokenField.css';

interface Props {
  label: string;
  value: string | null;
  emptyHint: string;
}

async function copyToClipboard(text: string) {
  try {
    // Windows: pipe text into clip.exe via shell plugin
    const cmd = Command.create('clip', [], { encoding: 'raw' });
    const child = await cmd.spawn();
    await child.write(new TextEncoder().encode(text));
    await child.kill();
  } catch {
    try { await navigator.clipboard.writeText(text); } catch {}
  }
}

export default function TokenField({ label, value, emptyHint }: Props) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!value) return;
    await copyToClipboard(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="token-field">
      <div className="token-field-header">
        <span className="token-field-label">{label}</span>
        {value && (
          <div className="token-actions">
            <button className="token-btn" onClick={() => setVisible(v => !v)}>
              {visible ? '隐藏' : '显示'}
            </button>
            <button
              className={`token-btn copy ${copied ? 'copied' : ''}`}
              onClick={handleCopy}
            >
              {copied ? '✓ 已复制' : '复制'}
            </button>
          </div>
        )}
      </div>
      {value ? (
        <div className={`token-text ${visible ? 'visible' : 'masked'}`}>
          {visible ? value : '•'.repeat(Math.min(value.length, 48))}
        </div>
      ) : (
        <div className="token-field-empty">{emptyHint}</div>
      )}
    </div>
  );
}
