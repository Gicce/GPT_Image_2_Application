import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { serverApi } from '../services/serverApi';
import { useSettingsStore } from '../store/useSettingsStore';
import './MarqueeNotice.css';

const POLL_INTERVAL = 3 * 60 * 1000;
const SPEED = 40;
const SPACER = 120;

export default function MarqueeNotice() {
  const [text, setText] = useState('');
  const [dismissedKey, setDismissedKey] = useState<string>('');
  const noticeEnabled = useSettingsStore(s => s.settings.notice_enabled);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const firstSpanRef = useRef<HTMLSpanElement>(null);
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  async function fetchNotice() {
    try {
      const data = await serverApi.getNotice();
      setText(data.content && (data.is_active !== false) ? data.content : '');
    } catch {}
  }

  // 初始化：读取本地记录的"已关闭公告"内容
  useEffect(() => {
    setDismissedKey(localStorage.getItem('cy_notice_dismissed') || '');
  }, []);

  useEffect(() => {
    if (!noticeEnabled) return;
    fetchNotice();
    timerRef.current = setInterval(fetchNotice, POLL_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [noticeEnabled]);

  useLayoutEffect(() => {
    if (!text || !firstSpanRef.current || !wrapperRef.current) return;
    const textWidth = firstSpanRef.current.scrollWidth;
    const step = textWidth + SPACER;
    const duration = step / SPEED;
    wrapperRef.current.style.setProperty('--marquee-step', `-${step}px`);
    wrapperRef.current.style.setProperty('--marquee-duration', `${duration}s`);
  }, [text]);

  function handleDismiss() {
    localStorage.setItem('cy_notice_dismissed', text);
    setDismissedKey(text);
  }

  // 设置里关闭 / 无内容 / 本地已手动关闭当前公告 → 隐藏
  if (!noticeEnabled || !text || dismissedKey === text) return null;

  return (
    <div className="marquee-bar">
      <span className="marquee-icon">📢</span>
      <div className="marquee-track">
        <div
          className="marquee-wrapper"
          ref={wrapperRef}
          style={prefersReducedMotion ? { animation: 'none' } : undefined}
        >
          <span className="marquee-text" ref={firstSpanRef}>{text}</span>
          <span className="marquee-gap" />
          <span className="marquee-text">{text}</span>
        </div>
      </div>
      <button className="marquee-close" onClick={handleDismiss} title="关闭通知">×</button>
    </div>
  );
}
