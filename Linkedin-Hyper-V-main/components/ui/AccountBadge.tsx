import { cn } from '@/lib/utils';

interface AccountBadgeProps {
  name: string;
  onClick?: () => void;
  className?: string;
}

export function AccountBadge({ name, onClick, className }: AccountBadgeProps) {
  const classes = cn(
    'inline-flex max-w-full items-center truncate rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--accent)]',
    onClick && 'transition-colors hover:bg-[var(--bg-hover)]',
    className
  );

  if (onClick) {
    return (
      <button onClick={onClick} className={classes} title={name}>
        {name}
      </button>
    );
  }

  return (
    <span className={classes} title={name}>
      {name}
    </span>
  );
}
