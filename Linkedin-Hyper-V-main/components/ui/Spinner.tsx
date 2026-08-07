'use client';

type SpinnerSize = 'sm' | 'md' | 'lg';

const sizeMap: Record<SpinnerSize, string> = {
  sm: 'w-4 h-4',
  md: 'w-6 h-6',
  lg: 'w-10 h-10',
};

const borderMap: Record<SpinnerSize, string> = {
  sm: 'border-2',
  md: 'border-2',
  lg: 'border-[3px]',
};

export function Spinner({ size = 'md' }: { size?: SpinnerSize }) {
  return (
    <div
      className={`${sizeMap[size]} ${borderMap[size]} rounded-full animate-spin`}
      style={{
        borderColor: 'var(--border)',
        borderTopColor: 'var(--accent)',
      }}
    />
  );
}
