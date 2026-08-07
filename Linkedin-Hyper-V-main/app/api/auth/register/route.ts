import { NextResponse } from 'next/server';

/**
 * Self-registration is DISABLED by default.
 *
 * The dashboard authenticates against a single shared `DASHBOARD_PASSWORD`
 * (see /api/auth/login). This route previously created a `users` row and
 * immediately issued a valid `app_session`, which let anyone who could reach
 * the app mint a fully-authorized session and bypass the password gate.
 *
 * It is now gated behind ALLOW_REGISTRATION=1 and, even when enabled, never
 * issues a session — an operator must still log in with the dashboard password.
 */
export async function POST() {
  if (process.env.ALLOW_REGISTRATION !== '1') {
    return NextResponse.json(
      { error: 'Registration is disabled' },
      { status: 404 }
    );
  }

  // When explicitly enabled, registration is an admin-only provisioning step and
  // must not hand out an authenticated session. Kept intentionally minimal.
  return NextResponse.json(
    { error: 'Registration is not available in this deployment' },
    { status: 403 }
  );
}
