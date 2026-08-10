import { useEffect, useState } from 'react';

interface RateLimitBarProps {
  label: string;
  current: number;
  limit: number;
  resetsAt?: number;
}

export function RateLimitBar({ label, current, limit, resetsAt }: RateLimitBarProps) {
  const percentage = limit > 0 ? Math.min((current / limit) * 100, 100) : 0;
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    if (!resetsAt) return;
    const timeoutId = setTimeout(() => setNowMs(Date.now()), 0);
    const intervalId = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    };
  }, [resetsAt]);

  const color = percentage < 50 ? 'var(--success)' : percentage < 80 ? 'var(--warning)' : 'var(--danger)';

  const resetLabel = (() => {
    if (!resetsAt || !nowMs) return '';
    const diffMs = resetsAt - nowMs;
    if (diffMs <= 0) return 'Reset now';
    const hours = Math.floor(diffMs / 3600000);
    const minutes = Math.floor((diffMs % 3600000) / 60000);
    return hours > 0 ? `Resets in ${hours}h ${minutes}m` : `Resets in ${minutes}m`;
  })();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-medium text-[var(--text-secondary)]">{label}</span>
        <span className="shrink-0 text-xs font-semibold text-[var(--text-primary)]">
          {current}/{limit}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-[var(--bg-subtle)]">
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${percentage}%`, background: color }} />
      </div>
      {resetLabel && <p className="text-xs text-[var(--text-muted)]">{resetLabel}</p>}
    </div>
  );
}
