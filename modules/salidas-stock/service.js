import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, readJsonBody, serveStatic } from '../../lib/http.js';
import { apiGet, apiPost, fetchLocals, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/salidas-stock';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

export async function handleRequest(pathname, url, request, response) {
  if (!pathname.startsWith('/api/')) return serveStatic(publicDir, pathname, response);
  try {
    if (pathname === '/api/locals') return json(response, 200, { locals: await withSession(fetchLocals) });
    if (pathname === '/api/categories') return json(response, 200, { categories: await withSession(categories) });
    if (pathname === '/api/almacenes') {
      const localId = url.searchParams.get('local_id');
      if (!/^\d+$/.test(String(localId))) return json(response, 400, { error: 'Selecciona un local válido.' });
      return json(response, 200, { almacenes: await withSession((page, session) => warehouses(page, session, localId)) });
    }
    if (pathname === '/api/items') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      const localId = url.searchParams.get('local_id');
      if (!query || !/^\d+$/.test(String(localId))) return json(response, 200, { items: [] });
      return json(response, 200, { items: await withSession((page, session) => searchItems(page, session, query, localId)) });
    }
    if (pathname === '/api/guardar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => create(page, session, body)));
    }
    if (pathname === '/api/salidas') return json(response, 200, await withSession((page, session) => list(page, session, url)));
    const detail = pathname.match(/^\/api\/salidas\/(\d+)$/);
    if (detail) return json(response, 200, await withSession((page, session) => getDetail(page, session, detail[1])));
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: error.message || 'No se pudo consultar Logística.' });
  }
}

async function categories(page, session) {
  const result = await apiGet(page, session.token, '/logistica/rest/common/obtenerCategoriasalidasListByEstado/1/0/0');
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({
    id: String(row.categoriasalida_id), name: row.categoriasalida_descripcion ?? '',
  })).filter((row) => row.id && row.name);
}

async function rawLocals(page, session) {
  const result = await apiGet(page, session.token, `/logistica/rest/producto/local/obtenerLocalesPermitidosParaUsuarioID/${session.userId}`);
  return Array.isArray(result.data) ? result.data : [];
}

async function rawWarehouses(page, session, localId) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/almacen/getAll/${localId}/1/0/0`);
  return Array.isArray(result.data) ? result.data : [];
}

async function warehouses(page, session, localId) {
  return (await rawWarehouses(page, session, localId))
    .filter((row) => String(row.almacen_controlstock) === '1')
    .map((row) => ({ id: String(row.almacen_id), name: row.almacen_descripcion ?? '' }));
}

async function searchItems(page, session, query, localId) {
  const result = await apiPost(page, session.token, '/logistica/rest/common/busqueda/busquedaSensitivaSegunTipos', {
    busqueda: query, esInsumo: 1, esReceta: 1, esPorcionable: 1, esDescartable: 1,
    esModificador: 0, esCombo: 1, esProdTrans: 1, esProdNoTrans: 1, busqPorCodigo: 0,
    agruparInsumo: 1, esDerivado: 1, obtenerSoloPreentacionesDeVenta: 0,
    esProdContStock: 0, agruparProducto: 0, esConsumible: 1, local_id: String(localId),
    proveedor_id: -1, esActivo: 1, paraArqueo: -1,
  });
  return (Array.isArray(result.data) ? result.data : []).slice(0, 30).map((item) => ({
    ...sanitizeRemoteData(item),
    id: String(item.item_id ?? ''), codigo: item.item_codigo ?? '', descripcion: item.item_descripcion ?? '',
    presentacion: item.presentacion_nombre ?? item.item_presentacion ?? '',
    unidad: item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? item.unidadmedida_descripcion ?? '',
  }));
}

async function create(page, session, body) {
  const localId = String(body.localId ?? '');
  const warehouseId = String(body.warehouseId ?? '');
  const categoryId = String(body.categoryId ?? '');
  const reason = String(body.reason ?? '').trim();
  const date = String(body.date ?? '').trim();
  const entries = Array.isArray(body.items) ? body.items : [];
  if (!/^\d+$/.test(localId) || !/^\d+$/.test(warehouseId) || !/^\d+$/.test(categoryId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !reason || entries.length === 0) {
    throw new Error('Completa local, almacén, categoría, fecha, razón y al menos un ítem.');
  }

  const [locals, allWarehouses, categoryResult] = await Promise.all([
    rawLocals(page, session), rawWarehouses(page, session, localId),
    apiGet(page, session.token, '/logistica/rest/common/obtenerCategoriasalidasListByEstado/1/0/0'),
  ]);
  const local = locals.find((row) => String(row.local_id) === localId);
  const warehouse = allWarehouses.find((row) => String(row.almacen_id) === warehouseId && String(row.almacen_controlstock) === '1');
  const category = (Array.isArray(categoryResult.data) ? categoryResult.data : []).find((row) => String(row.categoriasalida_id) === categoryId);
  if (!local || !warehouse || !category) throw new Error('La selección ya no está disponible en Restaurant. Actualiza el formulario.');

  const details = entries.map((entry) => {
    const item = entry.item ?? {};
    const quantity = Number(entry.quantity ?? 0);
    if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Cada ítem debe tener una cantidad mayor que cero.');
    const unit = item.unidadmedidainsumo ?? {
      unidadmedidainsumo_id: String(item.unidadmedidainsumo_id ?? 1),
      unidadmedidainsumo_descripcion: item.unidadmedida_descripcion ?? '',
    };
    const cost = Number(item.item_costo ?? item.producto_costo ?? 0);
    const isInsumo = String(item.item_tipo) === '1';
    const presentationId = String(item.item_presentacionid ?? item.presentacioninsumo_id ?? item.presentacion_id ?? '');
    return {
      ...item, merma_id: '-1', detallemerma_id: '-1', almacen_id: warehouseId, almacen: warehouse,
      insumo_id: isInsumo ? String(item.item_id) : null, producto_id: isInsumo ? null : String(item.item_id),
      presentacioninsumo_id: presentationId || null, presentacion_id: presentationId || null,
      item_cantidad: quantity, detallemerma_cantidad: quantity, detallemerma_descripcion: item.item_descripcion ?? '',
      detallemerma_unidadmedida: unit.unidadmedidainsumo_descripcion ?? '', detallemerma_precio: cost,
      detallemerma_costo: cost, detallemerma_importe: quantity * cost, detallemerma_total: quantity * cost,
      item_precio: cost, item_costo: cost, item_total: quantity * cost, unidadmedidainsumo: unit,
      detallecompra_cantidad: quantity, detallecompra_descripcion: item.item_descripcion ?? '',
      detallecompra_unidadmedida: unit, detallecompra_precio: cost, detallecompra_costo: cost,
      detallecompra_importe: quantity * cost,
      categoriasalida_id: categoryId, alteraStock: '1', esRecetaBase: '0', sePreparaEnVenta: '0', hasError: false,
    };
  });
  const total = details.reduce((sum, item) => sum + Number(item.detallemerma_importe ?? 0), 0);
  const merma = {
    merma_id: '-1', local_id: localId, localSeleccionado: local, almacenSeleccionado: warehouse,
    categoriasalidaSeleccionado: category, categoriasalida_id: categoryId,
    categoriasalida_descripcion: category.categoriasalida_descripcion ?? '', merma_razon: reason,
    merma_fecha: date, merma_hora: new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Lima' }),
    merma_estado: '1', merma_importe: total, merma_responsableid: null, alteraStock: '1',
  };
  const result = await apiPost(page, session.token, '/logistica/rest/merma/agregarMerma', { merma, detallemerma: details, movimientoEmulacion: null });
  return { ok: true, id: String(result.data?.merma_id ?? result.data ?? ''), mensajes: result.mensajes ?? [] };
}

async function list(page, session, url) {
  const locals = await fetchLocals(page, session);
  const allowed = new Set(locals.map((row) => String(row.id)));
  const selected = (url.searchParams.get('locales') ?? '').split(',').filter((id) => allowed.has(id));
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    pagina: Math.max(1, Number(url.searchParams.get('pagina') ?? 1)),
    locales: (selected.length ? selected : [...allowed]).join('-'),
    estado: Number(url.searchParams.get('estado') ?? 1),
    listaInsumoProducto: null,
    listaInsumoProductoSeleccionados: [],
    verDetalle: 0,
    local_id: String(session.localId ?? locals[0]?.id ?? ''),
    fecha_inicio: `${url.searchParams.get('fecha_inicio') ?? today} 00:00:00`,
    fecha_fin: `${url.searchParams.get('fecha_fin') ?? today} 23:59:59`,
    registros: Math.min(100, Math.max(10, Number(url.searchParams.get('registros') ?? 25))),
    categoriasalida_id: Number(url.searchParams.get('categoria_id') ?? -1),
    filtroPorFechaMerma: 1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const [result, header] = await Promise.all([
    apiGet(page, session.token, `/logistica/rest/merma/obtenerListaDeMermas/${encoded}?readonly=true&sobreEscribirRedis=0`),
    apiGet(page, session.token, `/logistica/rest/merma/obtenerCabeceraListaDeMermas/${encoded}`),
  ]);
  const rows = Array.isArray(result.data) ? result.data : [];
  return { filters: payload, header: header.data ?? {}, total: Number(result.totalregistros ?? rows.length), rows: rows.map(mapRow) };
}

async function getDetail(page, session, id) {
  const result = await apiGet(page, session.token, `/logistica/rest/merma/obtenerMerma/${id}`);
  const source = result.data ?? {};
  const merma = source.merma ?? source;
  const details = Array.isArray(source.detallemermaList) ? source.detallemermaList : (Array.isArray(source.detalle) ? source.detalle : []);
  return {
    sourceData: sanitizeRemoteData(source),
    id: String(merma.merma_id ?? id), fecha: merma.merma_fecha ?? '', hora: merma.merma_hora ?? '',
    localId: String(merma.local_id ?? merma.local?.local_id ?? ''), local: merma.local?.local_descripcion ?? '',
    categoria: merma.categoriasalida?.categoriasalida_descripcion ?? merma.categoriasalida_descripcion ?? '',
    responsable: merma.responsable?.usuario_nick ?? merma.merma_responsable ?? '',
    razon: merma.merma_razon ?? '', estado: merma.merma_estado ?? merma.estado ?? '',
    importe: Number(merma.merma_importe ?? 0),
    items: details.map((item) => ({
      id: String(item.detallemerma_id ?? item.id ?? ''), itemId: String(item.item_id ?? ''), itemCodigo: item.item_codigo ?? '',
      item: item.item_descripcion ?? item.descripcionProductoInsumo ?? '', tipo: item.item_tipo_descripcion ?? item.tipoItemDescripcion ?? '',
      almacenId: String(item.almacen_id ?? item.almacen?.almacen_id ?? ''), almacen: item.almacen?.almacen_descripcion ?? item.almacen_descripcion ?? '',
      unidad: item.unidadmedidainsumo?.unidadmedidainsumo_sigla ?? item.unidadmedidainsumo_descripcion ?? '',
      cantidad: Number(item.detallemerma_cantidad ?? item.item_cantidad ?? 0), costo: Number(item.detallemerma_costo ?? item.item_costo ?? 0),
      total: Number(item.detallemerma_total ?? item.item_total ?? 0), payloadRestaurant: sanitizeRemoteData(item),
    })),
  };
}

function mapRow(row) {
  return {
    id: String(row.merma_id ?? ''), fecha: row.merma_fecha ?? '', hora: row.merma_hora ?? '',
    localId: String(row.local_id ?? row.local?.local_id ?? ''), local: row.local?.local_descripcion ?? row.local_descripcion ?? '',
    responsable: row.responsable?.usuario_nick ?? row.merma_responsable ?? '',
    categoria: row.categoriasalida?.categoriasalida_descripcion ?? row.categoriasalida_descripcion ?? '',
    importe: Number(row.merma_importe ?? 0), razon: row.merma_razon ?? '', estado: row.merma_estado ?? row.estado ?? '',
    payloadRestaurant: sanitizeRemoteData(row),
  };
}
