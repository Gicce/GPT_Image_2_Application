import { Fragment, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { serverApi, isLoopbackUrl } from '../services/serverApi';
import { useSettingsStore } from '../store/useSettingsStore';
import { useRuntimeStore } from '../store/useRuntimeStore';
import './MarqueeNotice.css';

// SSE 为主通道（秒级实时）；低频轮询兜底（SSE 断开 / 服务端不支持时仍可拿到更新）
const POLL_INTERVAL = 10 * 60 * 1000;
const SPEED = 40;
const SPACER = 120;

export function calculateMarqueeCopies(trackWidth: number, itemWidth: number): number {
  if (trackWidth <= 0 || itemWidth <= 0) return 2;
  return Math.max(2, Math.ceil(trackWidth / itemWidth) + 2);
}

export default function MarqueeNotice() {
  const [text, setText] = useState('');
  const [dismissedKey, setDismissedKey] = useState<string>('');
  const [copyCount, setCopyCount] = useState(2);
  const noticeEnabled = useSettingsStore(s => s.settings.notice_enabled);
  // 等待 runtime ready（settings 恢复出真实 server_url）才建立轮询/SSE，
  // 否则启动瞬间会把 SSE 永久连到开发默认地址 localhost:4001
  const runtimeReady = useRuntimeStore(s => s.runtimeReady);
  const resolvedServerUrl = useRuntimeStore(s => s.resolvedServerUrl);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
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
    if (!noticeEnabled || !runtimeReady || !resolvedServerUrl) return;
    fetchNotice();
    timerRef.current = setInterval(fetchNotice, POLL_INTERVAL);

    // SSE 实时通知：后台保存公告 → 服务端广播 notice.updated → 立即重新 GET（数据真相仍走 GET）
    // 生产环境禁止把 SSE 连到本机回环地址（开发默认值泄漏）
    const sseAllowed = !(import.meta.env.PROD && isLoopbackUrl(resolvedServerUrl));
    try {
      if (sseAllowed) {
        const es = new EventSource(`${resolvedServerUrl}/api/notice/stream`);
        esRef.current = es;
        es.addEventListener('notice.updated', () => { void fetchNotice(); });
        es.onerror = () => { /* EventSource 原生自动重连（服务端下发 retry: 5000） */ };
      }
    } catch {
      // EventSource 不可用时仅依赖轮询兜底
    }

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
  }, [noticeEnabled, runtimeReady, resolvedServerUrl]);

  useLayoutEffect(() => {
    if (!text || !firstSpanRef.current || !wrapperRef.current || !trackRef.current) return;

    const updateLayout = () => {
      if (!firstSpanRef.current || !wrapperRef.current || !trackRef.current) return;
      const step = firstSpanRef.current.scrollWidth + SPACER;
      const duration = step / SPEED;
      wrapperRef.current.style.setProperty('--marquee-step', `-${step}px`);
      wrapperRef.current.style.setProperty('--marquee-duration', `${duration}s`);
      setCopyCount(prefersReducedMotion ? 1 : calculateMarqueeCopies(trackRef.current.clientWidth, step));
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(trackRef.current);
    observer.observe(firstSpanRef.current);
    return () => observer.disconnect();
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
      <div className="marquee-track" ref={trackRef}>
        <div
          className="marquee-wrapper"
          ref={wrapperRef}
          style={prefersReducedMotion ? { animation: 'none' } : undefined}
        >
          {Array.from({ length: copyCount }, (_, index) => (
            <Fragment key={index}>
              <span
                className="marquee-text"
                ref={index === 0 ? firstSpanRef : undefined}
                aria-hidden={index === 0 ? undefined : true}
              >
                {text}
              </span>
              <span className="marquee-gap" aria-hidden="true" />
            </Fragment>
          ))}
        </div>
      </div>
      <button className="marquee-close" onClick={handleDismiss} title="关闭通知">×</button>
    </div>
  );
}
