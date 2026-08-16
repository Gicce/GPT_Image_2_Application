import { useCallback, useRef, useState } from 'react';
import { copyText } from '../utils/clipboard';
import { toastSuccess } from './Toast';
import './PromptTextBlock.css';

interface Props {
  title: string;
  /** 完整原始文本；复制永远复制此值，而不是 DOM 中可能被折叠/截断的内容 */
  content: string;
  /** 复制成功 Toast 文案，如「提示词已复制」 */
  copyToastLabel?: string;
  copyable?: boolean;
  collapsible?: boolean;
  /** 折叠态显示的行数 */
  collapsedLines?: number;
  emptyHint?: string;
}

const LINE_HEIGHT = 20;

export default function PromptTextBlock({
  title,
  content,
  copyToastLabel,
  copyable = true,
  collapsible = true,
  collapsedLines = 6,
  emptyHint,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  const trimmed = content.trim();
  const isLong = collapsible && trimmed.length > 0 &&
    (trimmed.split('\n').length > collapsedLines || trimmed.length > collapsedLines * 28);

  const handleCopy = useCallback(async () => {
    if (!trimmed) return;
    const ok = await copyText(content);
    if (!ok) return;
    toastSuccess(copyToastLabel || '已复制');
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }, [content, trimmed, copyToastLabel]);

  if (!trimmed) {
    return emptyHint ? (
      <div className="ptb-block">
        <div className="ptb-header"><span className="ptb-title">{title}</span></div>
        <div className="ptb-empty">{emptyHint}</div>
      </div>
    ) : null;
  }

  return (
    <div className="ptb-block">
      <div className="ptb-header">
        <span className="ptb-title">{title}</span>
        {copyable && (
          <button
            className={`ptb-copy ${copied ? 'copied' : ''}`}
            onClick={handleCopy}
            title={copied ? '已复制' : `复制完整${title}`}
          >
            {copied ? '✓ 已复制' : '⧉ 复制'}
          </button>
        )}
      </div>
      <div
        className={`ptb-content ${isLong && !expanded ? 'collapsed' : ''}`}
        style={{ maxHeight: isLong && !expanded ? collapsedLines * LINE_HEIGHT : undefined }}
      >
        {content}
      </div>
      {isLong && (
        <button className="ptb-toggle" onClick={() => setExpanded(v => !v)}>
          {expanded ? '收起' : '展开全部'}
        </button>
      )}
    </div>
  );
}
