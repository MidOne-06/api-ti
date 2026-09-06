import { json, serveStatic } from '../../lib/http.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, apiPost, fetchLocals, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/movimientos-almacenes';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

/**
 * Consulta operativa: no replica movimientos en la BD del CRM. Cada página
 * se pide al mismo recurso de Restaurant que consume Logística.
 */
export async function handleRequest(pathname, url, request, response) {
  if (!pathname.startsWith('/api/')) return serveStatic(publicDir, pathname, response);

  try {
    if (pathname === '/api/locals') return json(response, 200, { locals: await withSession(fetchLocals) });
    if (pathname === '/api/contexto-filtros') return json(response, 200, await withSession(async (page, session) => {
      const locals = await fetchLocals(page, session);
      const localId = String(session.localId ?? '');
      return { local_id: localId, local_nombre: String(locals.find((local) => String(local.id) === localId)?.name ?? '') };
    }));
    if (pathname === '/api/almacenes') {
      const localId = String(url.searchParams.get('local_id') ?? '');
      if (!/^\d+$/.test(localId)) return json(response, 400, { error: 'Selecciona un local válido.' });
      return json(response, 200, { almacenes: await withSession((page, session) => warehouses(page, session, localId)) });
    }
    if (pathname === '/api/items') {
      const query = String(url.searchParams.get('q') ?? '').trim();
      const localId = String(url.searchParams.get('local_id') ?? '');
      if (query.length < 2 || !/^\d+$/.test(localId)) return json(response, 200, { items: [] });
      return json(response, 200, { items: await withSession((page, session) => items(page, session, query, localId)) });
    }
    if (pathname === '/api/movimientos') return json(response, 200, await withSession((page, session) => list(page, session, url)));

    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: error.message || 'No se pudo consultar Movimientos entre almacenes.' });
  }
}

async function warehouses(page, session, localId) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/almacen/getAll/${localId}/1/0/0`);
  return (Array.isArray(result.data) ? result.data : [])
    .map((row) => ({ id: String(row.almacen_id ?? ''), name: String(row.almacen_descripcion ?? '') }))
    .filter((row) => row.id && row.name);
}

async function items(page, session, query, localId) {
  const result = await apiPost(page, session.token, '/logistica/rest/common/busqueda/busquedaSensitivaSegunTipos', {
    busqueda: query, esInsumo: 1, esReceta: 1, esPorcionable: 1, esDescartable: 1,
    esModificador: 0, esCombo: 1, esProdTrans: 1, esProdNoTrans: 1, busqPorCodigo: 0,
    agruparInsumo: 1, esDerivado: 1, obtenerSoloPreentacionesDeVenta: 0,
    esProdContStock: 0, agruparProducto: 0, esConsumible: 1, local_id: localId,
    proveedor_id: -1, esActivo: 1, paraArqueo: -1,
  });

  return (Array.isArray(result.data) ? result.data : []).slice(0, 30).map((item) => ({
    id: String(item.item_id ?? ''), item_tipo: String(item.item_tipo ?? ''), codigo: String(item.item_codigo ?? ''),
    descripcion: String(item.item_descripcion ?? ''), presentacion: String(item.presentacion_nombre ?? item.item_presentacion ?? ''),
  })).filter((item) => item.id && item.item_tipo && item.descripcion);
}

async function list(page, session, url) {
  const payload = await movementFilter(page, session, url);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const [result, header] = await Promise.all([
    apiGet(page, session.token, `/logistica/rest/movimiento/obtenerListaDeMovimientos/${encoded}?readonly=true&sobreEscribirRedis=0`),
    apiGet(page, session.token, `/logistica/rest/movimiento/obtenerCabeceraListaDeMovimientos/${encoded}`),
  ]);
  const rows = Array.isArray(result.data) ? result.data : [];

  return {
    filters: payload,
    header: sanitizeRemoteData(header.data ?? {}),
    total: Number(result.totalregistros ?? rows.length),
    rows: rows.map(mapRow),
  };
}

async function movementFilter(page, session, url) {
  const locals = await fetchLocals(page, session);
  const allowed = new Set(locals.map((local) => String(local.id)));
  const selected = String(url.searchParams.get('locales') ?? '')
    .split(',').map((id) => id.trim()).filter((id) => allowed.has(id));
  const sessionLocalId = String(session.localId ?? '');
  const selectedLocals = selected.length ? selected : (allowed.has(sessionLocalId) ? [sessionLocalId] : [...allowed]);
  const today = new Date().toISOString().slice(0, 10);
  const itemPairs = String(url.searchParams.get('items') ?? '').split(',').map((value) => value.trim()).filter((value) => /^.+:\d+$/.test(value)).slice(0, 5);

  return {
    pagina: Math.max(1, Number(url.searchParams.get('pagina') ?? 1)),
    locales: selectedLocals.join('-'),
    tipodoc: -1,
    estado: Number(url.searchParams.get('estado') ?? 1),
    // Restaurant recibe estos dos atributos aun cuando no hay ítems. La forma
    // de cada selección se conserva como tipo:id y se transforma aquí, no en
    // el frontend del CRM.
    listaInsumoProducto: itemPairs.length ? itemPairs.map((value) => {
      const [item_tipo, item_id] = value.split(':', 2);
      return { item_tipo, item_id };
    }) : null,
    listaInsumoProductoSeleccionados: itemPairs,
    local_id: sessionLocalId || selectedLocals[0] || '',
    fecha_inicio: asDate(url.searchParams.get('fecha_inicio') ?? today, false),
    fecha_fin: asDate(url.searchParams.get('fecha_fin') ?? today, true),
    registros: Math.min(100, Math.max(10, Number(url.searchParams.get('registros') ?? 25))),
    serie: String(url.searchParams.get('serie') ?? ''),
    numero: String(url.searchParams.get('numero') ?? ''),
    buscarSegunLocal: Number(url.searchParams.get('buscar_segun') ?? 2),
    almacen: Number(url.searchParams.get('almacen') ?? -1),
    estadoRecepcion: Number(url.searchParams.get('estado_recepcion') ?? -1),
  };
}

function asDate(value, end) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? String(value) : new Date().toISOString().slice(0, 10);
  return `${date} ${end ? '23:59:59' : '00:00:00'}`;
}

function mapRow(row) {
  return {
    id: String(row.movimiento_id ?? ''),
    fecha: row.movimiento_fecha ?? null,
    localOrigenId: String(row.local_id ?? row.local?.local_id ?? ''),
    localOrigen: String(row.local?.local_descripcion ?? row.local_descripcion ?? ''),
    almacenOrigenId: String(row.almacen_id ?? row.almacen?.almacen_id ?? ''),
    almacenOrigen: String(row.almacen?.almacen_descripcion ?? row.almacen_descripcion ?? ''),
    localDestinoId: String(row.localTarget?.local_id ?? row.local_destino_id ?? ''),
    localDestino: String(row.localTarget?.local_descripcion ?? row.localdestino_descripcion ?? ''),
    almacenDestinoId: String(row.almacenTarget?.almacen_id ?? row.almacen_destino_id ?? ''),
    almacenDestino: String(row.almacenTarget?.almacen_descripcion ?? row.almacen_destino_descripcion ?? ''),
    encargado: String(row.movimiento_encargado ?? ''),
    receptor: String(row.movimiento_receptor ?? ''),
    registradoPor: String(row.usuario_nombrescompletos ?? row.usuario?.usuario_nick ?? ''),
    totalItems: Number(row.movimiento_totalItems ?? 0),
    valorizado: Number(row.movimiento_valorizado ?? row.movimiento_total ?? 0),
    estadoCodigo: String(row.movimiento_estado ?? ''),
    estado: String(row.estado ?? row.movimiento_estado ?? ''),
    estadoRecepcionCodigo: String(row.movimiento_estadorecepcion ?? ''),
    estadoRecepcion: String(row.estadoRecepcionDescripcion ?? row.movimiento_estadorecepcion ?? ''),
  };
}
