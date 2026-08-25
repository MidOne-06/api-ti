import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, serveStatic } from '../../lib/http.js';
import { apiGet, fetchLocals, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/ventas';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

const COMPROBANTES = [
  { value: '-1', label: 'Todos' },
  { value: 'Boleta', label: 'Boleta' },
  { value: 'Factura', label: 'Factura' },
  { value: 'Nota de venta', label: 'Nota de venta' },
];

const ESTADOS = [
  { value: '1', label: 'Activo' },
  { value: '0', label: 'Inactivo' },
  { value: '-1', label: 'Todos' },
];

const ORDEN = [
  { value: '1', label: 'Descendente' },
  { value: '2', label: 'Ascendente' },
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
    if (pathname === '/api/monedas') {
      return json(response, 200, { monedas: await withSession(fetchMonedas) });
    }
    if (pathname === '/api/opciones') {
      return json(response, 200, { comprobantes: COMPROBANTES, estados: ESTADOS, orden: ORDEN });
    }
    if (pathname === '/api/ventas') {
      const filters = parseFilters(url.searchParams);
      return json(response, 200, await withSession((page, session) => fetchVentas(page, session, filters)));
    }
    const detailMatch = pathname.match(/^\/api\/ventas\/(\d+)$/);
    if (detailMatch) {
      return json(response, 200, await withSession((page, session) => fetchVentaDetail(page, session, detailMatch[1])));
    }
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: 'No se pudo consultar Logística. Intenta nuevamente.' });
  }
}

async function fetchMonedas(page, session) {
  const result = await apiGet(page, session.token, '/logistica/rest/common/monedafacturacion/obtenerListaMonedafacturacion');
  const monedas = Array.isArray(result.data) ? result.data : [];
  return monedas.map((moneda) => ({ id: String(moneda.monedafacturacion_id), label: moneda.monedafacturacion_descripcion }));
}

async function fetchVentas(page, session, filters) {
  const payload = {
    pagina: filters.pagina,
    locales: filters.locales || session.localId,
    monedafacturacion_id: filters.moneda,
    comprobante_id: filters.comprobante,
    cliente_id: -1,
    usuario_id: -1,
    estado: filters.estado,
    tipoLista: 0,
    orden: filters.orden,
    local_id: session.localId,
    fecha_inicio: `${filters.fechaInicio} 00:00:00`,
    fecha_fin: `${filters.fechaFin} 23:59:59`,
    registros: filters.registros,
    serie: '',
    numero: '',
    searchCodUnico: '',
    itemIdList: '',
    itemTipoList: '',
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const result = await apiGet(page, session.token, `/logistica/rest/reporteria/venta/obtenerReporte/${encoded}?readonly=true&sobreEscribirRedis=0`);
  const cuerpo = result.data?.cuerpo ?? {};
  return {
    filters: payload,
    rows: Array.isArray(cuerpo.resultados) ? cuerpo.resultados : [],
    total: Number(cuerpo.totalRegistros ?? 0),
    pagina: Number(cuerpo.paginaActual ?? 1),
    paginas: Number(cuerpo.numeroPaginas ?? 1),
  };
}

async function fetchVentaDetail(page, session, id) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/venta/obtener/${id}`);
  const venta = result.data ?? {};
  const items = Array.isArray(venta.detalleventaList) ? venta.detalleventaList : [];
  return {
    source: 'Restaurant.pe Logística',
    sourceData: sanitizeRemoteData(venta),
    id: venta.venta_id,
    fecha: venta.venta_fecha,
    local: venta.local?.local_descripcion ?? '',
    cliente: {
      nombre: venta.cliente?.cliente_razonsocial ?? [venta.cliente?.cliente_nombres, venta.cliente?.cliente_apellidos].filter(Boolean).join(' '),
      ruc: venta.cliente?.cliente_dniruc ?? '',
    },
    comprobante: {
      tipo: venta.venta_tipodoc,
      serie: venta.venta_seriedoc,
      numero: venta.venta_numdoc,
    },
    moneda: venta.moneda?.monedafacturacion_descripcion ?? venta.moneda?.moneda_descripcion ?? '',
    subtotal: Number(venta.venta_subtotal ?? 0),
    descuento: Number(venta.venta_descuento ?? 0),
    impuestos: Number(venta.venta_igv ?? 0),
    total: Number(venta.venta_total ?? 0),
    formaPago: venta.venta_esalcredito === '1' ? 'Credito' : 'Contado',
    estado: venta.venta_estado,
    usuario: venta.usuario ? [venta.usuario.usuario_nombres, venta.usuario.usuario_apellidos].filter(Boolean).join(' ') : '',
    items: items.map((item) => ({
      id: item.detalleventa_id,
      descripcion: item.detalleventa_productodescripcion,
      cantidad: Number(item.detalleventa_cantidad ?? 0),
      precio: Number(item.detalleventa_precio ?? 0),
      descuento: Number(item.detalleventa_descuento ?? 0),
      importe: Number(item.detalleventa_importeventa ?? 0),
    })),
    pagos: (Array.isArray(venta.pagoventaList) ? venta.pagoventaList : []).map((pago) => ({
      tipo: pago.formapago?.formapago_descripcion ?? pago.pagoventa_tipo ?? '',
      monto: Number(pago.pagoventa_monto ?? 0),
    })),
  };
}

function parseFilters(params) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    locales: params.get('locales') ?? '',
    fechaInicio: params.get('fechaInicio') ?? today,
    fechaFin: params.get('fechaFin') ?? today,
    moneda: params.get('moneda') ?? '1',
    comprobante: params.get('comprobante') ?? '-1',
    estado: params.get('estado') ?? '1',
    orden: params.get('orden') ?? '1',
    pagina: Math.max(1, Number(params.get('pagina') ?? 1)),
    registros: Math.max(1, Number(params.get('registros') ?? 10)),
  };
}
