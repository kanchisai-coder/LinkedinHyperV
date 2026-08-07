'use client';

import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/utils';

export function Tabs({ children, defaultValue, value, onValueChange }: {
  children: React.ReactNode;
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
}) {
  return (
    <TabsPrimitive.Root defaultValue={defaultValue} value={value} onValueChange={onValueChange}>
      {children}
    </TabsPrimitive.Root>
  );
}

export function TabsList({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <TabsPrimitive.List className={cn('grid grid-cols-3 gap-1 rounded-lg bg-[var(--bg-subtle)] p-1', className)}>
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-semibold text-[var(--text-muted)] transition-colors data-[state=active]:bg-[var(--bg-panel)] data-[state=active]:text-[var(--text-primary)] data-[state=active]:shadow-sm"
    >
      {children}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <TabsPrimitive.Content value={value} className="mt-4 focus:outline-none">
      {children}
    </TabsPrimitive.Content>
  );
}
