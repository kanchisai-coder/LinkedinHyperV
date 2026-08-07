// FILE: lib/time-utils.ts
// Time formatting and filtering utilities

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Check if a timestamp is within the last hour
 */
export function isWithinLastHour(timestamp: string | number): boolean {
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  return time > Date.now() - ONE_HOUR_MS;
}

/**
 * Format a timestamp as relative time (e.g., "2 minutes ago", "Just now")
 */
export function formatRelativeTime(timestamp: string | number): string {
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const now = Date.now();
  const diffMs = now - time;
  
  // Just now (< 1 minute)
  if (diffMs < 60 * 1000) {
    return 'Just now';
  }
  
  // Minutes ago (< 1 hour)
  if (diffMs < ONE_HOUR_MS) {
    const minutes = Math.floor(diffMs / (60 * 1000));
    return `${minutes}m ago`;
  }
  
  // Hours ago (< 24 hours)
  if (diffMs < 24 * ONE_HOUR_MS) {
    const hours = Math.floor(diffMs / ONE_HOUR_MS);
    return `${hours}h ago`;
  }
  
  // Yesterday
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${formatTime(date)}`;
  }
  
  // This week
  if (diffMs < 7 * 24 * ONE_HOUR_MS) {
    const days = Math.floor(diffMs / (24 * ONE_HOUR_MS));
    return `${days}d ago`;
  }
  
  // Older dates
  return formatDate(date);
}

/**
 * Format a timestamp as "Today at 3:45 PM" or "Mar 20 at 11:00 AM"
 */
export function formatTimestamp(timestamp: string | number): string {
  const date = new Date(typeof timestamp === 'string' ? timestamp : timestamp);
  const now = new Date();
  
  // Today
  if (date.toDateString() === now.toDateString()) {
    return `Today at ${formatTime(date)}`;
  }
  
  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${formatTime(date)}`;
  }
  
  // This year
  if (date.getFullYear() === now.getFullYear()) {
    return `${formatShortDate(date)} at ${formatTime(date)}`;
  }
  
  // Other years
  return `${formatDate(date)} at ${formatTime(date)}`;
}

/**
 * Format time as "3:45 PM"
 */
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Format date as "Mar 20"
 */
function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format date as "Mar 20, 2026"
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Get a human-readable description of the time window
 */
export function getTimeWindowLabel(windowMs: number = ONE_HOUR_MS): string {
  const hours = windowMs / ONE_HOUR_MS;
  
  if (hours === 1) return 'Last hour';
  if (hours < 24) return `Last ${hours} hours`;
  
  const days = hours / 24;
  if (days === 1) return 'Last 24 hours';
  if (days === 7) return 'Last week';
  
  return `Last ${days} days`;
}
