/**
 * One place to load the bridge SDK, because the three places this code runs
 * disagree about how to do it and each rejects the others' way.
 *
 * A bare `import` is out everywhere: it resolves to the SDK's ESM build, which
 * takes named imports from `@coral-xyz/anchor`, a CommonJS package, and Node's
 * loader will not destructure that.
 *
 * So, by environment:
 *
 * - Vite's dev server transforms a relative import into its own module graph,
 *   and it cannot execute the `require` calls inside a CommonJS file: the page
 *   answered 500 with "require is not defined". `createRequire` sidesteps Vite
 *   entirely and hands the file to Node's CommonJS loader.
 * - The Vercel build needs the opposite. A dynamic require is invisible to the
 *   bundler, so the package was never shipped with the function and every
 *   request answered 500. An `import()` of a literal path is visible, and the
 *   SDK ends up inlined in the function.
 * - The CLI, plain Node, is happy with that same `import()`: the file is
 *   CommonJS, so its default export is `module.exports`.
 *
 * `import.meta.env` only exists under Vite, and `DEV` is replaced by a literal
 * at build time, so the branch costs nothing in the bundle.
 */

import { createRequire } from 'node:module';

const sdk = import.meta.env?.DEV
  ? createRequire(import.meta.url)('@securitize/solana-bridge-sdk')
  : (await import('../node_modules/@securitize/solana-bridge-sdk/dist/node/index.js')).default;

export const { SecuritizeBridgeClient, fetchLookupTablesByAuthority } = sdk;
