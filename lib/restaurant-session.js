import { chromium } from 'playwright';

const LOGIN_URL = 'http://corporaciondimsum.restaurant.pe/restaurant/logistica.html#!/login';
export const API_BASE = 'http://corporaciondimsum.restaurant.pe/restaurant';
const credentials = {
  user: process.env.DIMSUM_USER?.trim(),
  password: process.env.DIMSUM_PASSWORD,
};
const SESSION_TTL_MS = 20 * 60 * 1000;
// Mantener la sesión reutilizable solo durante una ventana breve. Así las
// consultas consecutivas evitan un nuevo login, sin dejar navegadores de
// Restaurant consumiendo RAM cuando el sistema está inactivo.
const IDLE_SESSION_TTL_MS = Math.max(5_000, Number.parseInt(process.env.RESTAURANT_IDLE_SESSION_TTL_MS ?? '30000', 10) || 30_000);
// Una página de Playwright no ejecuta en paralelo los page.evaluate().  Por eso
// un único login convertía cualquier extracción masiva en una cola serial.
// Cada slot mantiene su propio navegador, contexto, token y página.
const SESSION_POOL_SIZE = Math.max(1, Number.parseInt(process.env.RESTAURANT_SESSION_POOL_SIZE ?? '4', 10) || 4);
const sessionPool = [];
const sessionWaiters = [];

if (!credentials.user || !credentials.password) {
  throw new Error('Configura DIMSUM_USER y DIMSUM_PASSWORD en .env antes de iniciar el servidor.');
}

export async function withSession(work) {
  const slot = await acquireSession();
  try {
    return await work(slot.current.page, slot.current.session);
  } catch (error) {
    if (!/sesión|sesion|HTTP 401|HTTP 403|no fue aceptada/i.test(error.message)) throw error;
    await clearSlot(slot);
    slot.current = await loginSession();
    return await work(slot.current.page, slot.current.session);
  } finally {
    releaseSession(slot);
  }
}

async function acquireSession() {
  const idle = sessionPool.find((slot) => !slot.busy);
  if (idle) {
    idle.busy = true;
    clearTimeout(idle.disposeTimer);
    idle.disposeTimer = null;
    try {
      if (!idle.current || idle.current.expiresAt <= Date.now()) {
        await clearSlot(idle);
        idle.current = await loginSession();
      }
      return idle;
    } catch (error) {
      sessionPool.splice(sessionPool.indexOf(idle), 1);
      throw error;
    }
  }

  if (sessionPool.length < SESSION_POOL_SIZE) {
    const slot = { busy: true, current: null, disposeTimer: null };
    sessionPool.push(slot);
    try {
      slot.current = await loginSession();
      return slot;
    } catch (error) {
      sessionPool.splice(sessionPool.indexOf(slot), 1);
      throw error;
    }
  }

  return new Promise((resolve) => sessionWaiters.push(resolve));
}

function releaseSession(slot) {
  const waiter = sessionWaiters.shift();
  if (waiter) return waiter(slot);
  slot.busy = false;
  clearTimeout(slot.disposeTimer);
  slot.disposeTimer = setTimeout(() => disposeIdleSlot(slot), IDLE_SESSION_TTL_MS);
}

async function disposeIdleSlot(slot) {
  if (slot.busy || !sessionPool.includes(slot)) return;
  await clearSlot(slot);
  sessionPool.splice(sessionPool.indexOf(slot), 1);
  console.log(`Sesión Restaurant.pe liberada por inactividad (pool ${sessionPool.length}/${SESSION_POOL_SIZE}).`);
}

async function loginSession() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.locator('#username').fill(credentials.user);
    await page.locator('#password').fill(credentials.password);
    const login = page.waitForResponse((res) => /\/m\/rest\/usuario\/login$/i.test(res.url()));
    await page.locator('form[name="loginForm"] button[type="submit"]').click();
    if ((await login).status() !== 200) throw new Error('Login rechazado por Logística.');
    await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.includes('currentUserLogistica')));
    const session = await page.evaluate(() => {
      const raw = localStorage.getItem('ngStorage-currentUserLogistica');
      const current = raw ? JSON.parse(raw) : null;
      return { token: current?.token, localId: current?.local_id, userId: current?.usuario_id };
    });
    if (!session.token) throw new Error('El login no entregó una sesión válida.');
    console.log(`Sesión Restaurant.pe iniciada (pool ${sessionPool.length}/${SESSION_POOL_SIZE}).`);
    return { browser, page, session, expiresAt: Date.now() + SESSION_TTL_MS };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function clearSlot(slot) {
  if (!slot.current) return;
  const previous = slot.current;
  slot.current = null;
  await previous.browser.close().catch(() => {});
}

export async function apiGet(page, token, path) {
  // No usar fetch dentro del documento del ERP: luego de un reinicio el
  // navegador puede bloquearlo por CORS/red y Playwright solo reporta el
  // opaco "Failed to fetch". El request context comparte cookies con la
  // sesión autenticada y permite recibir el HTTP real y su cuerpo.
  const response = await page.context().request.get(`${API_BASE}${path}`, {
    headers: { Authorization: `Token token="${token}"`, Accept: 'application/json' },
  });
  if (!response.ok()) throw new Error(`Restaurant respondió HTTP ${response.status()} al consultar datos.`);
  const result = await response.json();
  if (String(result.tipo) !== '1') {
    console.warn(`Restaurant rechazó GET ${path}: tipo=${String(result.tipo ?? 'desconocido')} mensaje=${JSON.stringify(result.mensajes ?? result.message ?? result.error ?? null)}`);
    throw new Error(result.mensajes?.[0] ?? result.message ?? result.error ?? `Restaurant rechazó la consulta (tipo ${String(result.tipo ?? 'desconocido')}).`);
  }
  return result;
}

export async function apiPost(page, token, path, body) {
  const result = await apiPostRaw(page, token, path, body);
  if (String(result.tipo) !== '1') {
    console.warn(`Restaurant rechazó POST ${path}: tipo=${String(result.tipo ?? 'desconocido')} mensaje=${JSON.stringify(result.mensajes ?? result.message ?? result.error ?? null)}`);
    const message = Array.isArray(result.mensajes) ? result.mensajes.find(Boolean) : null;
    throw new Error(message ?? result.message ?? result.error ?? `Restaurant rechazó la operación (tipo ${String(result.tipo ?? 'desconocido')}).`);
  }
  return result;
}

// Some endpoints (e.g. cuadremanual/getStockParaCuadreV2) don't respond with the
// standard {tipo, mensajes, data} envelope, so they can't go through the tipo check in apiPost.
export async function apiPostRaw(page, token, path, body) {
  const response = await page.context().request.post(`${API_BASE}${path}`, {
    headers: { Authorization: `Token token="${token}"`, 'Content-Type': 'application/json', Accept: 'application/json' },
    data: body,
  });
  if (!response.ok()) throw new Error(`Restaurant respondió HTTP ${response.status()} al guardar datos.`);
  return response.json();
}

// Para descargas binarias (reportes xlsx/csv) que Restaurant.pe autentica por
// token en el querystring, no por header -- calzan con cómo el propio ERP las
// abre (window.open a report.php). Usa el contexto de Playwright en vez de
// page.evaluate() porque el body no es JSON y puede pesar varios MB.
export async function fetchBinary(page, url) {
  const response = await page.context().request.get(url);
  if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
  return {
    buffer: await response.body(),
    contentType: response.headers()['content-type'] ?? 'application/octet-stream',
  };
}

export async function fetchLocals(page, session) {
  const locals = await fetchLocalsDetail(page, session);
  return locals.locals.map((item) => ({
    id: String(item.local_id),
    name: item.descripcion ?? item.local_descripcion ?? item.local_nombre ?? `Local ${item.local_id}`,
  }));
}

export async function fetchLocalsDetail(page, session) {
  if (!session.userId) throw new Error('La sesión no indicó el usuario actual.');
  const result = await apiGet(page, session.token, `/logistica/rest/producto/local/obtenerLocalesPermitidosParaUsuarioID/${session.userId}`);
  const locals = Array.isArray(result.data) ? result.data : [];
  return {
    source: 'Restaurant.pe Logística',
    count: locals.length,
    locals: locals.map(toLocalDetail),
  };
}

export function sanitizeRemoteData(value) {
  if (Array.isArray(value)) return value.map(sanitizeRemoteData);
  if (!value || typeof value !== 'object') return value;
  const sensitive = /(?:clave|pin|token|llavesecreta|cuentabanc|nombresyape|documentoyape|datoschasqui|datoslimadelivery|ipimpresion|urlcertificado|pixel|checksum)/i;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitive.test(key))
    .map(([key, child]) => [key, sanitizeRemoteData(child)]));
}

export function toLocalDetail(local) {
  return {
    local_id: local.local_id,
    razonsocial_id: local.razonsocial_id,
    descripcion: local.local_descripcion,
    nombre_comercial: local.local_nombrecomercial,
    razon_social: local.local_razonsocial,
    ruc: local.local_ruc,
    estado: local.local_estado,
    direccion: local.local_direccion,
    calle: local.local_calle,
    urbanizacion: local.local_urbanizacion,
    departamento: local.local_departamento,
    provincia: local.local_provincia,
    distrito: local.local_distrito,
    ubigeo: local.local_coddistritoubigeo,
    pais: local.local_codpais,
    telefono: local.local_telefono,
    encargado: local.local_encargado,
    latitud: local.local_latitud,
    longitud: local.local_longitud,
    zona_horaria: local.local_zonahoraria,
    es_produccion: local.local_esproduccion,
    es_venta: local.local_esventa,
    acepta_delivery: local.local_aceptadelivery,
    acepta_recojo: local.local_aceptarecojo,
    acepta_pago_en_linea: local.local_aceptapagoenlinea,
    acepta_entrega_programada: local.local_aceptaentregaprogramada,
    monto_minimo: local.local_montominimo,
    costo_delivery: local.local_costodelivery,
    tiempo_minimo_delivery: local.local_tiempominimodelivery,
    tiempo_maximo_delivery: local.local_tiempomaximodelivery,
    orden: local.local_orden,
  };
}
