'use client';

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

export function Dialog({ open, onOpenChange, children }: DialogProps) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {children}
    </DialogPrimitive.Root>
  );
}

export function DialogTrigger({ children }: { children: React.ReactNode }) {
  return <DialogPrimitive.Trigger asChild>{children}</DialogPrimitive.Trigger>;
}

export function DialogContent({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay asChild>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-slate-950/55 backdrop-blur-sm"
        />
      </DialogPrimitive.Overlay>
      <DialogPrimitive.Content asChild>
        <motion.div
          initial={{ opacity: 0, scale: 0.98, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 12 }}
          transition={{ duration: 0.18 }}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[92vh] w-[calc(100vw-24px)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-panel)] p-5 shadow-xl sm:p-6',
            className
          )}
        >
          {children}
          <DialogPrimitive.Close asChild>
            <button
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
          </DialogPrimitive.Close>
        </motion.div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
  return (
    <DialogPrimitive.Title className="pr-10 text-lg font-semibold text-[var(--text-primary)]">
      {children}
    </DialogPrimitive.Title>
  );
}

export function DialogDescription({ children }: { children: React.ReactNode }) {
  return (
    <DialogPrimitive.Description className="mt-1 text-sm text-[var(--text-muted)]">
      {children}
    </DialogPrimitive.Description>
  );
}
