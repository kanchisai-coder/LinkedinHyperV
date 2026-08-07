'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('App Error:', error);
  }, [error]);

  const isDev = process.env.NODE_ENV === 'development';

  return (
    <div
      className="min-h-screen flex items-center justify-center py-12 px-4"
      style={{ background: 'var(--bg-base)' }}
    >
      <div
        className="max-w-md w-full space-y-8 p-10 rounded-xl text-center"
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
        }}
      >
        <div>
          <h2
            className="mt-6 text-3xl font-extrabold"
            style={{ color: 'var(--text-primary)' }}
          >
            Something went wrong!
          </h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            {isDev
              ? error.message
              : 'An unexpected error occurred while loading this page.'}
          </p>
        </div>
        <div className="mt-8 space-y-4 flex flex-col items-center">
          <button
            onClick={() => reset()}
            className="w-full flex justify-center py-3 px-4 rounded-lg text-sm font-medium text-white transition-colors"
            style={{ background: 'var(--accent)' }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.background =
                'var(--accent-hover)')
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLButtonElement).style.background =
                'var(--accent)')
            }
          >
            Try Again
          </button>
          <Link
            href="/"
            className="w-full flex justify-center py-3 px-4 rounded-lg text-sm font-medium transition-colors"
            style={{
              background: 'var(--bg-card)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border)',
            }}
          >
            Go Home
          </Link>
        </div>
      </div>
    </div>
  );
}
