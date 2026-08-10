'use client';

import Link from 'next/link';

export default function NotFound() {
  return (
    <main
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="max-w-2xl mx-auto text-center py-16 px-6">
        <p
          className="text-base font-semibold tracking-wide uppercase"
          style={{ color: 'var(--accent)' }}
        >
          404 Error
        </p>
        <h1
          className="mt-2 text-4xl font-extrabold tracking-tight sm:text-5xl"
          style={{ color: 'var(--text-primary)' }}
        >
          Page Not Found
        </h1>
        <p className="mt-4 text-base mb-8" style={{ color: 'var(--text-muted)' }}>
          Sorry, we couldn&apos;t find the page you&apos;re looking for. It might have
          been moved or doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="inline-flex items-center px-6 py-3 rounded-lg text-sm font-medium text-white transition-colors"
          style={{ background: 'var(--accent)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLAnchorElement).style.background =
              'var(--accent-hover)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLAnchorElement).style.background =
              'var(--accent)')
          }
        >
          Return Home
        </Link>
      </div>
    </main>
  );
}
