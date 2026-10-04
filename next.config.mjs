// .mjs (jo .ts) me qëllim: në Termux, Next.js përdor SWC në WASM dhe konfigurimi
// në TypeScript është burim problemesh. JavaScript i thjeshtë ngarkohet kudo.
/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        // Cache i shkurtër: një rregullim i widget-it arrin te të gjitha faqet brenda 5 min.
        source: '/widget.js',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=300, s-maxage=300' }],
      },
      {
        source: '/((?!widget.js).*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
