import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { serverApi, getConfiguredServerUrl } from '../services/serverApi';
import { useSettingsStore } from '../store/useSettingsStore';
import './MarqueeNotice.css';

// SSE 为主通道（秒级实时）；低频轮询兜底（SSE 断开 / 服务端不支持时仍可拿到更新）
const POLL_INTERVAL = 10 * 60 * 1000;
const SPEED = 40;
const SPACER = 120;

export default function MarqueeNotice() {
  const [text, setText] = useState('');
  const [dismissedKey, setDismissedKey] = useState<string>('');
  const noticeEnabled = useSettingsStore(s => s.settings.notice_enabled);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);
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

    // SSE 实时通知：后台保存公告 → 服务端广播 notice.updated → 立即重新 GET（数据真相仍走 GET）
    try {
      const base = getConfiguredServerUrl().replace(/\/+$/, '');
      const es = new EventSource(`${base}/api/notice/stream`);
      esRef.current = es;
      es.addEventListener('notice.updated', () => { void fetchNotice(); });
      es.onerror = () => { /* EventSource 原生自动重连（服务端下发 retry: 5000） */ };
    } catch {
      // EventSource 不可用时仅依赖轮询兜底
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
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
