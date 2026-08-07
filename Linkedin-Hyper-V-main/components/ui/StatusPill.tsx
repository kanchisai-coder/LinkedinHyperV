import { cn } from '@/lib/utils';

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'info';

interface StatusPillProps {
  children: React.ReactNode;
  tone?: StatusTone;
  dot?: boolean;
  className?: string;
}

const tones: Record<StatusTone, string> = {
  success: 'bg-[var(--success-soft)] text-[var(--success)]',
  warning: 'bg-[var(--warning-soft)] text-[var(--warning)]',
  danger: 'bg-[var(--danger-soft)] text-[var(--danger)]',
  neutral: 'bg-[var(--bg-subtle)] text-[var(--text-muted)]',
  info: 'bg-[var(--info-soft)] text-[var(--info)]',
};

export function StatusPill({ children, tone = 'neutral', dot = false, className }: StatusPillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
