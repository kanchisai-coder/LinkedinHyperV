// FILE: components/accounts/CookieInstructions.tsx
export function CookieInstructions() {
  return (
    <div className="space-y-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <div>
        <h3 className="font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          How to Export LinkedIn Cookies
        </h3>
        <p className="mb-4" style={{ color: 'var(--text-muted)' }}>
          Follow these steps to export your LinkedIn session cookies from your browser:
        </p>
      </div>

      <div className="space-y-3">
        <div className="flex gap-3">
          <div
            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            1
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Open LinkedIn in your browser
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Navigate to linkedin.com and ensure you&apos;re logged in to the account you want to add.
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <div
            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            2
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Open Developer Tools
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Press <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>F12</code> (Windows/Linux) or{' '}
              <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>Cmd+Opt+I</code> (Mac)
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <div
            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            3
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Navigate to Cookies
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Go to <strong>Application</strong> tab -&gt; <strong>Cookies</strong> -&gt; <strong>https://www.linkedin.com</strong>
            </p>
          </div>
        </div>

        <div className="flex gap-3">
          <div
            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            4
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Export as JSON
            </p>
            <div style={{ color: 'var(--text-muted)' }}>
              <p className="mb-2">
                Option 1: Use a browser extension like <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>EditThisCookie</code> or{' '}
                <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>Cookie-Editor</code>
              </p>
              <p className="mb-2">Option 2: Manually copy cookies in this format:</p>
              <pre
                className="p-3 rounded text-xs overflow-x-auto"
                style={{ background: 'var(--bg-elevated)', fontFamily: 'monospace' }}
              >
{`[
  {
    "name": "li_at",
    "value": "AQE...",
    "domain": ".linkedin.com",
    "path": "/",
    "httpOnly": true,
    "secure": true
  },
  {
    "name": "JSESSIONID",
    "value": "\\"ajax:...\\"",
    "domain": ".linkedin.com",
    "path": "/",
    "httpOnly": false,
    "secure": true
  }
]`}
              </pre>
            </div>
          </div>
        </div>

        <div className="flex gap-3">
          <div
            className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            5
          </div>
          <div>
            <p className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Required Cookies
            </p>
            <p style={{ color: 'var(--text-muted)' }}>
              Make sure to include at least <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>li_at</code> and{' '}
              <code className="px-1 py-0.5 rounded" style={{ background: 'var(--bg-elevated)' }}>JSESSIONID</code>. Including all cookies is recommended.
            </p>
          </div>
        </div>
      </div>

      <div
        className="p-3 rounded-lg border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      >
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--accent)' }}>Note:</strong> Cookies expire after ~2 weeks.
          You&apos;ll need to re-import them when your session expires.
        </p>
      </div>
    </div>
  );
}
