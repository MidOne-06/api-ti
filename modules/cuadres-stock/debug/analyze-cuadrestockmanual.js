import dotenv from 'dotenv';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

dotenv.config({ quiet: true });

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
const LOGIN_URL = 'http://corporaciondimsum.restaurant.pe/restaurant/logistica.html#!/login';
const TARGET_URL = 'http://corporaciondimsum.restaurant.pe/restaurant/logistica.html#!/cuadrestockmanual/lista?params=eyJwYWdpbmEiOjEsImxvY2FsZXMiOiIxIiwiZXN0YWRvIjoiMSIsImxvY2FsX2lkIjoiMSIsImZlY2hhX2luaWNpbyI6IjIwMjYtMDgtMDEgMDA6MDAiLCJmZWNoYV9maW4iOiIyMDI2LTA4LTMxIDIzOjU5OjU5IiwicmVnaXN0cm9zIjoyNSwidGlwbyI6LTEsIml0ZW1JZExpc3QiOiIiLCJpdGVtVGlwb0xpc3QiOiIifQ%3D%3D';

const config = {
  user: process.env.DIMSUM_USER?.trim(),
  password: process.env.DIMSUM_PASSWORD,
  headless: process.env.HEADLESS === 'true',
  slowMo: Number(process.env.SLOW_MO ?? 100),
};

if (!config.user || !config.password) {
  throw new Error('Define DIMSUM_USER y DIMSUM_PASSWORD en .env.');
}

const browser = await chromium.launch({ headless: config.headless, slowMo: config.slowMo });
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(60_000);

const events = [];
context.on('request', async (request) => {
  if (!['xhr', 'fetch'].includes(request.resourceType())) return;
  const headers = await request.allHeaders();
  events.push({
    kind: 'request',
    method: request.method(),
    url: sanitizeUrl(request.url()),
    postData: sanitizePayload(request.postData()),
    hasAuthorization: Boolean(headers.authorization),
    authorizationScheme: headers.authorization?.split(/\s+/, 1)[0] ?? null,
    at: new Date().toISOString(),
  });
});
context.on('response', async (response) => {
  const request = response.request();
  if (!['xhr', 'fetch'].includes(request.resourceType())) return;
  events.push({
    kind: 'response',
    method: request.method(),
    status: response.status(),
    contentType: response.headers()['content-type'] ?? null,
    url: sanitizeUrl(response.url()),
    at: new Date().toISOString(),
  });
});
context.on('requestfailed', (request) => {
  events.push({
    kind: 'failed',
    method: request.method(),
    url: sanitizeUrl(request.url()),
    error: request.failure()?.errorText ?? 'unknown',
    at: new Date().toISOString(),
  });
});

try {
  console.log('1/3 Iniciando sesión visual...');
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
  await page.locator('#username').fill(config.user);
  await page.locator('#password').fill(config.password);
  const loginResponse = page.waitForResponse((response) => /\/m\/rest\/usuario\/login$/i.test(response.url()));
  await page.locator('form[name="loginForm"] button[type="submit"]').click();
  const login = await loginResponse;
  if (login.status() !== 200) throw new Error(`El login devolvió HTTP ${login.status()}.`);
  await page.waitForFunction(
    () => Object.keys(localStorage).some((key) => key.includes('currentUserLogistica')),
    null,
    { timeout: 30_000 },
  );

  console.log('2/3 Navegando a Cuadre de stock manual...');
  events.length = 0;
  await page.waitForTimeout(2_000);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(8_000);

  console.log('3/3 Guardando tráfico XHR/fetch sanitizado...');
  const targetEvents = events.filter((event) => /cuadre|stock|insumo|almacen/i.test(event.url));
  await writeFile(join(ARTIFACTS_DIR, 'network-cuadrestockmanual.json'), JSON.stringify({ targetUrl: TARGET_URL, events, targetEvents }, null, 2));
  await page.screenshot({ path: join(ARTIFACTS_DIR, 'cuadrestockmanual.png'), fullPage: true });

  const endpoints = [...new Set(targetEvents.filter((event) => event.kind === 'request').map((event) => `${event.method} ${event.url}`))];
  console.log(`Solicitudes XHR/fetch: ${events.filter((event) => event.kind === 'request').length}.`);
  console.log(`Solicitudes relacionadas: ${endpoints.length}.`);
  for (const endpoint of endpoints) console.log(endpoint);
} finally {
  await browser.close();
}

function sanitizeUrl(url) {
  return url
    .replace(/([?&](?:token|authorization|auth|cookie|password|clave)=)[^&]*/gi, '$1[REDACTED]')
    .replace(/(deleteTokenByToken\/)[^/?#]+/gi, '$1[REDACTED]');
}

function sanitizePayload(payload) {
  if (!payload) return null;
  try {
    return JSON.stringify(sanitizeObject(JSON.parse(payload)));
  } catch {
    return payload.replace(/((?:token|authorization|auth|cookie|password|clave)["'=:\\s]+)[^,}&\s]+/gi, '$1[REDACTED]');
  }
}

function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /token|authorization|auth|cookie|password|clave/i.test(key) ? '[REDACTED]' : sanitizeObject(item),
    ]));
  }
  return value;
}
