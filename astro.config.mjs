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
});
