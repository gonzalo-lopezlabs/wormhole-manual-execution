import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  output: 'server',
  // A redemption is several transactions with confirmations; the Vercel
  // default duration cuts it off.
  adapter: vercel({ maxDuration: 60 }),
  // 4322 instead of Astro's default: the browser may hold a cached 301 from
  // some other project that ran on localhost:4321.
  server: { port: 4322 },
  vite: {
    ssr: {
      // The bridge SDK is bundled from its CommonJS build, and its `require` of
      // spl-token comes out the other side as a default import. spl-token has no
      // default export, so the function refused to load until it was bundled
      // too, letting rollup settle the interop at build time.
      noExternal: [
        '@solana/spl-token',
        '@solana/buffer-layout-utils',
        '@solana/spl-token-group',
        '@solana/spl-token-metadata',
      ],
    },
  },
});
