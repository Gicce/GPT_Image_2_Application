import './ContextMeter.css';

interface Props {
  used: number;
  limit: number;
}

export default function ContextMeter({ used, limit }: Props) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const level = pct >= 95 ? 'danger' : pct >= 90 ? 'warn' : 'ok';

  return (
    <div className={`context-meter ${level}`} title={`上下文 ${used} / ${limit} tokens`}>
      <svg viewBox="0 0 36 36">
        <path className="track" d="M18 2a16 16 0 1 1 0 32a16 16 0 0 1 0-32" />
        <path
          className="bar"
          pathLength="100"
          strokeDasharray={`${pct} 100`}
          d="M18 2a16 16 0 1 1 0 32a16 16 0 0 1 0-32"
        />
      </svg>
      <span>{pct}%</span>
    </div>
  );
}
