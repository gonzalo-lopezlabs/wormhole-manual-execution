/**
 * One place to load the bridge SDK, because neither obvious way works alone.
 *
 * A bare `import` resolves to the SDK's ESM build, which takes named imports
 * from `@coral-xyz/anchor`, a CommonJS package, and Node's ESM loader rejects
 * that. `createRequire` avoids it by loading the CommonJS build instead, but a
 * dynamic require is invisible to the Vercel bundler, so the package never made
 * it into the deployed function and every request to /api/redeem answered 500.
 *
 * A static import of the CommonJS build by literal path satisfies both: Node
 * gives us `module.exports` as the default export, and the bundler can see the
 * dependency and ship it.
 */

import sdk from '../node_modules/@securitize/solana-bridge-sdk/dist/node/index.js';

export const { SecuritizeBridgeClient, fetchLookupTablesByAuthority } = sdk;
