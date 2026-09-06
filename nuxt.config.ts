const apiBase = process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3001';
const wsBase = process.env.NUXT_PUBLIC_WS_BASE || 'ws://localhost:3001';
const devConnectSrc = process.env.NODE_ENV === 'production' ? [] : ['http://localhost:*', 'ws://localhost:*'];
const connectSrc = ["'self'", apiBase, wsBase, ...devConnectSrc].join(' ');

export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  app: {
    head: {
      title: 'ShareMe',
      meta: [
        { name: 'referrer', content: 'no-referrer' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  routeRules: {
    '/**': {
      headers: {
        'content-security-policy': `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob: ${apiBase}; connect-src ${connectSrc}; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';`,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      },
    },
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      apiBase,
      wsBase,
      maxFileSize: Number(process.env.NUXT_PUBLIC_MAX_FILE_SIZE || 250 * 1024 * 1024),
    },
  },
  typescript: {
    strict: true,
  },
});
