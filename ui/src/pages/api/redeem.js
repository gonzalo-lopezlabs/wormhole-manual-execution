import { spawn } from 'node:child_process';
import path from 'node:path';

export const prerender = false;

// The CLI lives one level above ui/. The server is started from ui/, so cwd
// resolves to the project root both in dev and in preview.
const PROJECT_ROOT = path.resolve(process.cwd(), '..');

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

  const child = spawn('node', ['index.js', `tx=${tx}`, `privKey=${privKey}`], {
    cwd: PROJECT_ROOT,
  });

  // If the page disconnects we stop streaming but let the child finish: a
  // redemption half-killed after postear el VAA is worse than a closed tab.
  let open = true;
  const stream = new ReadableStream({
    start(controller) {
      const push = chunk => {
        if (open) controller.enqueue(new Uint8Array(chunk));
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', error => {
        push(Buffer.from(`no se pudo lanzar el proceso: ${error.message}\n`));
      });
      child.on('close', code => {
        push(Buffer.from(`\n[proceso terminado con codigo ${code}]\n`));
        if (open) controller.close();
        open = false;
      });
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
