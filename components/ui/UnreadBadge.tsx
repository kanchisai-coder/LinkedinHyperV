import { formatCount } from '@/lib/utils';

interface UnreadBadgeProps {
  count: number;
  color?: 'red' | 'blue';
}

export function UnreadBadge({ count, color = 'red' }: UnreadBadgeProps) {
  const label = formatCount(count);
  if (!label) return null;   // returns null at count === 0

  const badgeStyle = {
    backgroundColor:
      color === 'blue' ? 'var(--accent)' : 'var(--color-error-500)',
  };

  return (
    <span
      className="inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full text-[10px] font-bold text-white px-1 flex-shrink-0"
      style={badgeStyle}
    >
      {label}
    </span>
  );
}
