import dotenv from 'dotenv';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

dotenv.config({ quiet: true });

const ARTIFACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'artifacts');
const LOGIN_URL = 'http://corporaciondimsum.restaurant.pe/restaurant/logistica.html#!/login';
const config = {
  user: process.env.DIMSUM_USER?.trim(),
  password: process.env.DIMSUM_PASSWORD,
  local: process.env.DIMSUM_LOCAL?.trim() || 'FABRICA',
  headless: process.env.HEADLESS === 'true',
  keepOpen: process.env.KEEP_OPEN === 'true',
  slowMo: Number(process.env.SLOW_MO ?? 150),
};

if (!config.user || !config.password) {
  throw new Error('Define DIMSUM_USER y DIMSUM_PASSWORD en un archivo .env.');
}

const browser = await chromium.launch({
  headless: config.headless,
  slowMo: Number.isFinite(config.slowMo) ? config.slowMo : 150,
});
const context = await browser.newContext();
const page = await context.newPage();
page.setDefaultTimeout(45_000);

const network = [];
context.on('request', (request) => {
  network.push({
    type: 'request',
    method: request.method(),
    url: request.url(),
    resourceType: request.resourceType(),
    at: new Date().toISOString(),
  });
});
context.on('response', (response) => {
  network.push({
    type: 'response',
    status: response.status(),
    url: response.url(),
    at: new Date().toISOString(),
  });
});
context.on('requestfailed', (request) => {
  network.push({
    type: 'failed',
    method: request.method(),
    url: request.url(),
    failure: request.failure()?.errorText ?? 'unknown',
    at: new Date().toISOString(),
  });
});

try {
  console.log('1/4 Abriendo Logística Dim Sum...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  console.log('2/4 Seleccionando local...');
  await selectLocal(page, config.local);

  console.log('3/4 Ingresando credenciales...');
  await page.locator('#username').fill(config.user);
  await page.locator('#password').fill(config.password);

  console.log('4/4 Enviando formulario y esperando respuesta...');
  const loginResponse = page.waitForResponse(
    (response) => /\/usuario\/login(?:[/?]|$)/i.test(response.url()),
    { timeout: 45_000 },
  ).catch(() => null);
  await page.locator('button[type="submit"], button:has-text("Iniciar sesión")').first().click();
  const response = await loginResponse;
  await page.waitForTimeout(3_000);

  await writeFile(join(ARTIFACTS_DIR, 'network-dimsum.json'), JSON.stringify(network, null, 2));
  await page.screenshot({ path: join(ARTIFACTS_DIR, 'login-dimsum-result.png'), fullPage: true });
  console.log(`Reporte guardado: network-dimsum.json (${network.length} eventos).`);
  if (response) {
    console.log(`Login: ${response.status()} ${response.url()}`);
    console.log(`Content-Type: ${response.headers()['content-type'] ?? 'no informado'}`);
  } else {
    console.log('No se detecto una respuesta /usuario/login en 45 segundos.');
  }

  if (config.keepOpen) console.log('Navegador abierto para revisión manual. Ciérralo al terminar.');
  else await browser.close();
} catch (error) {
  console.error(`Error durante el login: ${error.message}`);
  await page.screenshot({ path: join(ARTIFACTS_DIR, 'login-dimsum-error.png'), fullPage: true }).catch(() => {});
  await writeFile(join(ARTIFACTS_DIR, 'network-dimsum.json'), JSON.stringify(network, null, 2));
  await browser.close();
  throw error;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function selectLocal(page, desiredLocal) {
  const control = page.locator('.ui-select-container').first();
  await control.waitFor({ state: 'visible' });
  const normalizedTarget = normalize(desiredLocal);
  const selected = await control.locator('.ui-select-match-text').innerText();
  if (normalize(selected) === normalizedTarget) return;

  await control.locator('.ui-select-toggle').click();
  const option = page.locator('.ui-select-choices-row-inner').filter({
    hasText: new RegExp(`^\\s*${escapeRegExp(desiredLocal)}\\s*$`, 'i'),
  });
  await option.first().click();

  const confirmed = await control.locator('.ui-select-match-text').innerText();
  if (normalize(confirmed) !== normalizedTarget) {
    throw new Error(`No se pudo seleccionar el local ${desiredLocal}. Local actual: ${confirmed}`);
  }
}

function normalize(value) {
  return value.normalize('NFD').replace(/[^\w\s]/g, '').trim().toUpperCase();
}
