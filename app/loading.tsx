export default function Loading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="flex flex-col items-center gap-4">
        <div
          className="w-16 h-16 rounded-full animate-spin"
          style={{
            border: '4px solid var(--border)',
            borderTopColor: 'var(--accent)',
          }}
        />
        <p
          className="font-medium text-lg animate-pulse"
          style={{ color: 'var(--accent)' }}
        >
          Loading…
        </p>
      </div>
    </div>
  );
}
