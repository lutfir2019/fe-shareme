export default defineNuxtConfig({
  compatibilityDate: '2026-09-05',
  app: {
    head: {
      title: 'ShareMe',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
    },
  },
  css: ['~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:3001',
      wsBase: process.env.NUXT_PUBLIC_WS_BASE || 'ws://localhost:3001',
    },
  },
  typescript: {
    strict: true,
  },
});
