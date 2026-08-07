import { getInitials } from '@/lib/utils';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg';

interface AvatarProps {
  name: string;
  size?: AvatarSize;
}

const sizeClasses: Record<AvatarSize, string> = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
};

export function Avatar({ name, size = 'md' }: AvatarProps) {
  return (
    <div
      className={`${sizeClasses[size]} flex shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-semibold text-white ring-1 ring-white/70`}
      title={name}
    >
      {getInitials(name)}
    </div>
  );
}
