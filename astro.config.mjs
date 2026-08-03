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
      // The bridge SDK is bundled from its CommonJS build, so rollup rewrites
      // each `require` it makes into a default import. That is fine for a
      // CommonJS dependency, where the default is `module.exports`, and fatal
      // for an ESM one, which has no default: the function then refuses to load
      // with "does not provide an export named 'default'". These are the ESM
      // packages reachable that way, so they are bundled too and rollup settles
      // the interop at build time. `noExternal: true` would cover it in one
      // line but breaks the build in rollup.
      //
      // The list was not guessed. Importing the built chunk with plain node
      // reproduces the deployed failure exactly, so each name here came from
      // building, importing, and reading the package it named:
      //   node -e "import('./.vercel/output/functions/_render.func/dist/server/pages/api/redeem.astro.mjs')"
      noExternal: [
        '@noble/hashes',
        '@solana/buffer-layout-utils',
        '@solana/codecs',
        '@solana/codecs-core',
        '@solana/codecs-data-structures',
        '@solana/codecs-numbers',
        '@solana/codecs-strings',
        '@solana/errors',
        '@solana/options',
        '@solana/spl-token',
        '@solana/spl-token-group',
        '@solana/spl-token-metadata',
      ],
    },
  },
});
