import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, serveStatic } from '../../lib/http.js';
import { API_BASE, apiGet, fetchBinary, fetchLocals, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/kardex';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

// Catálogo real de vm.motivosKardexList (Kardex General -> Restaurant.pe
// Logística). No hay endpoint REST propio para esto -- viene fijo en el
// controlador Angular (kardexGeneralCtrl), así que se replica tal cual.
const MOTIVOS = [
  { id: 1, label: 'Entrada, por apertura' },
  { id: 2, label: 'Entrada, por compra' },
  { id: 3, label: 'Entrada, por movimiento' },
  { id: 12, label: 'Entrada, por preparación de receta' },
  { id: 22, label: 'Entrada, por regulación de stock manual' },
  { id: 26, label: 'Entrada, por guía' },
  { id: 5, label: 'Salida, por venta. ' },
  { id: 6, label: 'Salida, por merma' },
  { id: 9, label: 'Salida, por movimiento' },
  { id: 14, label: 'Salida, por preparación de receta' },
  { id: 23, label: 'Salida, por regulación de stock manual' },
  { id: 24, label: 'Salida, por merma automatica en compra' },
  { id: 32, label: 'Salida, por nota de crédito en compra' },
  { id: 27, label: 'Salida, por merma automatica en guía' },
  { id: 35, label: 'Salida, por merma en cuadre de stock' },
  { id: 36, label: 'Salida, por guía de remisión' },
  { id: 38, label: 'Salida, por merma en preparación' },
  { id: 39, label: 'Salida, por compra de servicio' },
  { id: 41, label: 'Salida, por merma en preparación de receta' },
  { id: -2, label: 'TODAS LAS ENTRADAS' },
  { id: -3, label: 'TODAS LAS SALIDAS' },
  { id: -1, label: 'TODOS' },
];

export async function handleRequest(pathname, url, request, response) {
  if (pathname.startsWith('/api/')) return handleApi(pathname, url, response);
  return serveStatic(publicDir, pathname, response);
}

async function handleApi(pathname, url, response) {
  try {
    if (pathname === '/api/locals') {
      return json(response, 200, { locals: await withSession(fetchLocals) });
    }
    if (pathname === '/api/almacenes') {
      const localId = url.searchParams.get('local_id');
      if (!localId) return json(response, 400, { error: 'Falta local_id.' });
      return json(response, 200, { almacenes: await withSession((page, session) => fetchAlmacenes(page, session, localId)) });
    }
    if (pathname === '/api/motivos') {
      return json(response, 200, { motivos: MOTIVOS });
    }
    if (pathname === '/api/reporte') {
      return await handleReporte(url, response);
    }
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: error.message || 'No se pudo consultar Logística. Intenta nuevamente.' });
  }
}

async function fetchAlmacenes(page, session, localId) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/almacen/getAll/${localId}/1/0/0`);
  const almacenes = Array.isArray(result.data) ? result.data : [];
  return almacenes
    .filter((almacen) => String(almacen.almacen_controlstock) === '1')
    .map((almacen) => ({ id: String(almacen.almacen_id), nombre: almacen.almacen_descripcion }));
}

async function handleReporte(url, response) {
  const params = url.searchParams;
  const localId = params.get('local_id');
  if (!localId) return json(response, 400, { error: 'Selecciona un local.' });

  const type = params.get('type') === 'csv' ? 'csv' : 'excel';
  const version = ['1', '2', '3'].includes(params.get('version')) ? params.get('version') : '1';

  let tipoBusqueda;
  try {
    tipoBusqueda = computeTipoBusqueda(params);
  } catch (error) {
    return json(response, 400, { error: error.message });
  }

  const fechaInicio = params.get('fecha_inicio');
  const fechaFin = params.get('fecha_fin');
  if (!fechaInicio || !fechaFin) return json(response, 400, { error: 'Selecciona un rango de fechas.' });

  const reportParams = new URLSearchParams({
    page: 'informemovimientoconsolidado_informestock',
    name: 'InformeKardex',
    type,
    or: 'L',
    kardex_valorizado: params.get('kardex_valorizado') === '1' ? '1' : '0',
    tipo_busqueda: tipoBusqueda,
    almacen_id: params.get('almacen_id') || '-1',
    // El selector de mes/año del ERP no está enlazado al rango de fechas real
    // (fechaInicio/fechaFin) -- siempre viaja fijo así, tal como lo hace la
    // página original (mes=Enero, año actual), sin control visible en la UI.
    mes: '01',
    anio: String(new Date().getFullYear()),
    motivo: params.get('motivo') || '-1',
    pagina: '-1',
    registros: '-1',
    estado: '1',
    fechaInicio: `${fechaInicio} 00:00:00`,
    fechaFin: `${fechaFin} 23:59:59`,
    vercostosinimpuesto: params.get('vercostosinimpuesto') === '1' ? '1' : '0',
    readOnly: '0',
    local_id: localId,
    version,
  });

  const { buffer, contentType } = await withSession(async (page, session) => {
    reportParams.set('token', session.token);
    const reportUrl = `${API_BASE}/api/reports/report.php?${reportParams.toString()}`;
    return fetchBinary(page, reportUrl);
  });

  const extension = type === 'csv' ? 'csv' : 'xlsx';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="kardex-v${version}.${extension}"`,
    'Content-Length': buffer.length,
  });
  response.end(buffer);
}

// Replica exacta de vm.fnGenerarInformeKardex: Producto="0", Insumo="1",
// Derivado="2"; si se marcan los 3 el ERP manda tipo_busqueda=-1 (TODOS) en
// vez de "0,1,2". Sin ningún tipo marcado, el ERP no descarga nada.
function computeTipoBusqueda(params) {
  const parts = [];
  if (params.get('tipo_producto') === '1') parts.push('0');
  if (params.get('tipo_insumo') === '1') parts.push('1');
  if (params.get('tipo_derivado') === '1') parts.push('2');
  if (parts.length === 0) throw new Error('Selecciona al menos un tipo de ítem (Derivados, Insumos o Productos).');
  if (parts.length === 3) return '-1';
  return parts.join(',');
}
