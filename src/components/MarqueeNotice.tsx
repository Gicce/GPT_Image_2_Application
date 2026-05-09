import { useState, useEffect, useRef } from 'react';
import { serverApi } from '../services/serverApi';
import { useSettingsStore } from '../store/useSettingsStore';
import './MarqueeNotice.css';

const POLL_INTERVAL = 3 * 60 * 1000; // 3 分钟

export default function MarqueeNotice() {
  const [text, setText] = useState('');
  const serverUrl = useSettingsStore(s => s.settings.server_url);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchNotice() {
    if (!serverUrl) return;
    try {
      const data = await serverApi.getNotice();
      setText(data.is_active && data.content ? data.content : '');
    } catch {
      // 静默失败，不影响主功能
    }
  }

  useEffect(() => {
    if (!serverUrl) return;
    fetchNotice();
    timerRef.current = setInterval(fetchNotice, POLL_INTERVAL);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [serverUrl]);

  if (!text) return null;

  return (
    <div className="marquee-bar">
      <span className="marquee-icon">📢</span>
      <div className="marquee-track">
        <span className="marquee-text">{text}</span>
      </div>
    </div>
  );
}
