export function timeAgo(input: number | string): string {
  const ms   = typeof input === 'number' ? input : new Date(input).getTime();
  const diff = Date.now() - ms;

  if (diff < 60_000)        return 'just now';
  if (diff < 3_600_000)     return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)    return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000)   return `${Math.floor(diff / 86_400_000)}d ago`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 604_800_000)}w ago`;
  return `${Math.floor(diff / 2_592_000_000)}mo ago`;
}

export function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function formatCount(n: number): string {
  if (n <= 0)  return '';
  if (n > 99)  return '99+';
  return String(n);
}

export function groupByDate<T extends { sentAt: number | string }>(
  messages: T[]
): { label: string; messages: T[] }[] {
  const groups: Map<string, T[]> = new Map();

  for (const msg of messages) {
    const d     = new Date(msg.sentAt);
    const label = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'short', day: 'numeric',
    });
    const existing = groups.get(label) ?? [];
    existing.push(msg);
    groups.set(label, existing);
  }

  return Array.from(groups.entries()).map(([label, messages]) => ({ label, messages }));
}

export function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  return arr.reduce((acc, item) => {
    const k = key(item);
    (acc[k] ??= []).push(item);
    return acc;
  }, {} as Record<string, T[]>);
}

export function clsx(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(' ');
}

export const cn = clsx;