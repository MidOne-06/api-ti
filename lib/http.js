import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

export function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function serveStatic(rootDir, pathname, response) {
  const requested = pathname === '/' || pathname === '' ? '/index.html' : pathname;
  const file = normalize(join(rootDir, requested));
  if (!file.startsWith(rootDir)) return json(response, 403, { error: 'Acceso no permitido.' });
  try {
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': STATIC_TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'No encontrado.' });
  }
}

export async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function mapWithConcurrency(items, limit, work) {
  const result = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await work(items[index]);
    }
  }));
  return result;
}
