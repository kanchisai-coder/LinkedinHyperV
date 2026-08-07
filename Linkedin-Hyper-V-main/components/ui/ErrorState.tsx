'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './Button';

interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex min-h-[320px] flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--danger-soft)] text-[var(--danger)]">
        <AlertTriangle size={22} />
      </div>
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Something went wrong</h2>
        <p className="mt-1 max-w-sm text-sm text-[var(--text-muted)]">{message}</p>
      </div>
      {onRetry && (
        <Button onClick={onRetry} variant="secondary" size="sm">
          <RotateCcw size={14} />
          Retry
        </Button>
      )}
    </div>
  );
}
