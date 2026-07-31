import { redeem, describeError } from '../../../lib/redeem.js';

export const prerender = false;

export async function POST({ request }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('cuerpo invalido, se espera JSON', { status: 400 });
  }
  const tx = (body.tx || '').trim();
  const privKey = (body.privKey || '').trim();
  if (!tx || !privKey) {
    return new Response('faltan tx o privKey', { status: 400 });
  }

  // The redemption runs in-process and its progress lines stream back as they
  // happen. If the page disconnects we stop streaming but let it finish: a
  // redemption half-killed after posting the VAA is worse than a closed tab.
  let open = true;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const log = line => {
        if (open) controller.enqueue(encoder.encode(`${line}\n`));
      };
      try {
        await redeem(tx, privKey, log);
      } catch (error) {
        log(`error: ${describeError(error)}`);
        if (error.logs) log(error.logs.slice(-6).join('\n'));
      } finally {
        if (open) controller.close();
        open = false;
      }
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
