import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  // 4322 instead of Astro's default: the browser may hold a cached 301 from
  // some other project that ran on localhost:4321.
  server: { port: 4322 },
});
