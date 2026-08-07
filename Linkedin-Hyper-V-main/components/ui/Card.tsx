import React from 'react';
import { cn } from '@/lib/utils';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  interactive?: boolean;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ children, interactive = false, className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'app-surface overflow-hidden',
        interactive && 'transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-subtle)]',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
);

Card.displayName = 'Card';
