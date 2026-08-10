import React from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: string;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, description, eyebrow, actions, meta, className }: PageHeaderProps) {
  return (
    <div className={cn('border-b border-[var(--border)]/80 bg-white/70 px-4 py-5 backdrop-blur-xl sm:px-6 lg:px-8', className)}>
      <div className="mx-auto flex max-w-[1440px] flex-col gap-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          {eyebrow && (
            <p className="app-kicker mb-2">
              {eyebrow}
            </p>
          )}
          <h1 className="truncate text-2xl font-semibold text-[var(--text-primary)] sm:text-3xl">
            {title}
          </h1>
          {description && (
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[var(--text-muted)] sm:text-[15px]">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2.5">{actions}</div>}
      </div>
      {meta && <div>{meta}</div>}
      </div>
    </div>
  );
}
