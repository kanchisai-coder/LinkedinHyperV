import { cn } from '@/lib/utils';

interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

interface FilterBarProps {
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function FilterBar({ options, value, onChange, className }: FilterBarProps) {
  return (
    <div className={cn('flex gap-2 overflow-x-auto pb-1', className)}>
      {options.map((option) => {
        const isActive = value === option.value;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
              isActive
                ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                : 'border-[var(--border)] bg-[var(--bg-panel)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]'
            )}
          >
            {option.label}
            {typeof option.count === 'number' && (
              <span className={cn('rounded-full px-1.5 py-0.5 text-[10px]', isActive ? 'bg-white/20' : 'bg-[var(--bg-subtle)]')}>
                {option.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
