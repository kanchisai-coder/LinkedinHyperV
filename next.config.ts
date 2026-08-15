import type { NextConfig } from "next";

function buildPermissionsPolicy() {
  const features = [
    'camera=()',
    'microphone=()',
    'geolocation=()',
    'fullscreen=*',
    'clipboard-read=*',
    'clipboard-write=*',
  ];

  return features.join(', ');
}

const nextConfig: NextConfig = {
  experimental: {
    turbopackUseSystemTlsCerts: true,
  },
  turbopack: {
    root: process.cwd(),
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'placehold.co',
        port: '',
        pathname: '/**',
      },
    ],
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options',        value: 'SAMEORIGIN' },
          { key: 'X-XSS-Protection',       value: '1; mode=block' },
          { key: 'Referrer-Policy',        value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy',     value: buildPermissionsPolicy() },
          // SECURITY (F5): Content-Security-Policy.
          // Rationale for each directive:
          //   default-src 'self'        — baseline deny-all, fall through to specific directives
          //   script-src  'self' 'unsafe-inline' — Next.js RSC hydration embeds inline scripts;
          //                               nonce-based CSP requires custom server not available
          //                               in Next.js standalone output; accept as known framework limitation.
          //   style-src   'self' 'unsafe-inline' — Tailwind CSS + Next.js injects inline styles.
          //   img-src     'self' data: https://placehold.co — self + placehold.co (remotePatterns) + data: URIs.
          //   connect-src 'self' wss: — Socket.IO / WSS websocket connections to origin.
          //   frame-src   'none'         — application does not embed external iframes.
          //   frame-ancestors 'self'     — prevent clickjacking by disallowing embedding outside origin.
          //   object-src  'none'         — no plugins permitted.
          //   base-uri    'self'         — prevent base tag injection.
          //   form-action 'self'         — all form submissions must stay on origin.
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://placehold.co",
              "font-src 'self' data:",
              "connect-src 'self' wss:",
              "frame-src 'none'",
              "frame-ancestors 'self'",
              "object-src 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
  output: 'standalone',
};

export default nextConfig;
