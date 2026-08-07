import React from 'react';
import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center ${compact ? 'p-6' : 'min-h-[260px] p-8'}`}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
        {icon ?? <Inbox size={22} />}
      </div>
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
