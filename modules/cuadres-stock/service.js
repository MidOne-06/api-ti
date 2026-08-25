import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, mapWithConcurrency, serveStatic } from '../../lib/http.js';
import { apiGet, apiPost, fetchLocals, fetchLocalsDetail, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/cuadres-stock';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

// Restaurant.pe entrega los cuadres paginados. El tamaño se mantiene prudente
// para no sobrecargar la sesión remota; el reporte recorre todas las páginas.
const STOCK_REPORT_PAGE_SIZE = 50;
const STOCK_REPORT_PAGE_CONCURRENCY = 2;
const STOCK_REPORT_DETAIL_CONCURRENCY = 4;

export async function handleRequest(pathname, url, request, response) {
  if (pathname.startsWith('/api/')) return handleApi(pathname, url, response);
  return serveStatic(publicDir, pathname, response);
}

async function handleApi(pathname, url, response) {
  try {
    if (pathname === '/api/locals') {
      return json(response, 200, { locals: await withSession(fetchLocals) });
    }
    if (pathname === '/api/locals/detail') {
      return json(response, 200, await withSession(fetchLocalsDetail));
    }
    if (pathname === '/api/filter-options') {
      return json(response, 200, filterOptions());
    }
    if (pathname === '/api/items') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      return json(response, 200, { items: query ? await withSession((page, session) => searchItems(page, session, query)) : [] });
    }
    if (pathname === '/api/stock-report') {
      const filters = parseFilters(url.searchParams);
      return json(response, 200, await withSession((page, session) => fetchStockReport(page, session, filters)));
    }
    const detailMatch = pathname.match(/^\/api\/cuadres\/(\d+)$/);
    if (detailMatch) {
      return json(response, 200, await withSession((page, session) => fetchCuadreDetail(page, session, detailMatch[1])));
    }
    if (pathname === '/api/cuadres') {
      const filters = parseFilters(url.searchParams);
      return json(response, 200, await withSession((page, session) => fetchCuadres(page, session, filters)));
    }
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: 'No se pudo consultar Logística. Intenta nuevamente.' });
  }
}

async function fetchCuadres(page, session, filters) {
  const selectedLocal = filters.locales || session.localId;
  const payload = {
    pagina: filters.pagina,
    locales: selectedLocal,
    estado: filters.estado,
    local_id: session.localId,
    fecha_inicio: `${filters.fechaInicio} 00:00:00`,
    fecha_fin: `${filters.fechaFin} 23:59:59`,
    registros: filters.registros,
    tipo: filters.tipo,
    itemIdList: filters.itemIdList,
    itemTipoList: filters.itemTipoList,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const [header, list] = await Promise.all([
    apiGet(page, session.token, `/logistica/rest/cuadremanual/obtenerCabeceraDeCuadresmanualesPorUrlEncodeada/${encoded}`),
    apiGet(page, session.token, `/logistica/rest/cuadremanual/obtenerListaDeCuadresmanualesPorUrlEncodeada/${encoded}?readonly=true&sobreEscribirRedis=0`),
  ]);
  return { filters: payload, header: header.data ?? {}, rows: list.data ?? [], total: Number(list.totalregistros ?? 0) };
}

async function fetchCuadreDetail(page, session, id) {
  const cuadre = await fetchCuadreRaw(page, session, id);
  const items = Array.isArray(cuadre.detalle) ? cuadre.detalle : [];
  return {
    source: 'Restaurant.pe Logística',
    sourceData: sanitizeRemoteData(cuadre),
    id: cuadre.cuadremanual_id,
    motivo: cuadre.cuadremanual_motivo ?? '',
    fechaCuadre: cuadre.cuadremanual_fecha,
    fechaRegistro: cuadre.cuadremanual_fecharegistro,
    estado: cuadre.estado,
    local: cuadre.local?.local_descripcion ?? cuadre.cuadremanual_local,
    registradoPor: [cuadre.usuario?.usuario_nombres, cuadre.usuario?.usuario_apellidos].filter(Boolean).join(' '),
    usuario: cuadre.usuario?.usuario_nick ?? '',
    items: items.map((item) => {
      const aumento = Number(item.detallecuadremanual_cantidadaumento ?? 0);
      const disminuyo = Number(item.detallecuadremanual_cantidaddisminuyo ?? 0);
      const stockAnterior = Number(item.detallecuadremanual_stockanterior ?? 0);
      const costoTotal = Number(item.detallecuadremanual_costopromedio ?? 0);
      const costoSinImpuestos = Number(item.detallecuadremanual_costopromediosinimpuestos ?? 0);
      return {
        id: item.detallecuadremanual_id,
        item: item.descripcionProductoInsumo,
        tipo: item.tipoItemDescripcion,
        almacen: item.almacen?.almacen_descripcion ?? '',
        aumento,
        disminuyo,
        costo: costoSinImpuestos,
        impuestos: costoTotal - costoSinImpuestos,
        total: costoTotal,
        stockAnterior,
        stockActual: stockAnterior + aumento - disminuyo,
        unidad: item.unidadmedidainsumo?.unidadmedidainsumo_sigla ?? '',
        valorizacion: (aumento - disminuyo) * costoTotal,
      };
    }),
  };
}

async function fetchCuadreRaw(page, session, id) {
  const result = await apiGet(page, session.token, `/logistica/rest/cuadremanual/obtenerCuadremanual/${id}`);
  return result.data ?? {};
}

async function fetchAllCuadres(page, session, filters) {
  const firstPage = await fetchCuadres(page, session, {
    ...filters,
    pagina: 1,
    registros: STOCK_REPORT_PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(firstPage.total / STOCK_REPORT_PAGE_SIZE));

  if (pages === 1) {
    return { ...firstPage, pages };
  }

  const remainingPages = Array.from({ length: pages - 1 }, (_, index) => index + 2);
  const remaining = await mapWithConcurrency(remainingPages, STOCK_REPORT_PAGE_CONCURRENCY, (pagina) => fetchCuadres(page, session, {
    ...filters,
    pagina,
    registros: STOCK_REPORT_PAGE_SIZE,
  }));

  return {
    ...firstPage,
    rows: [
      ...firstPage.rows,
      ...remaining.flatMap((result) => result.rows),
    ],
    pages,
  };
}

async function fetchStockReport(page, session, filters) {
  const cuadres = await fetchAllCuadres(page, session, filters);
  const details = await mapWithConcurrency(
    cuadres.rows,
    STOCK_REPORT_DETAIL_CONCURRENCY,
    async (row) => fetchCuadreRaw(page, session, row.cuadremanual_id),
  );
  const master = new Map();
  for (const cuadre of details) {
    const local = cuadre.local?.local_descripcion ?? cuadre.cuadremanual_local ?? '';
    const fecha = cuadre.cuadremanual_fecha ?? '';
    const fechaRegistro = cuadre.cuadremanual_fecharegistro ?? '';
    for (const item of Array.isArray(cuadre.detalle) ? cuadre.detalle : []) {
      const unidad = item.unidadmedidainsumo?.unidadmedidainsumo_sigla ?? '';
      const key = [cuadre.local_id, item.almacen_id, item.item_id, unidad].join(':');
      const existing = master.get(key);
      const orden = [fecha, fechaRegistro, cuadre.cuadremanual_id ?? ''].join('|');
      if (existing && existing.orden >= orden) continue;
      const aumento = Number(item.detallecuadremanual_cantidadaumento ?? 0);
      const disminuyo = Number(item.detallecuadremanual_cantidaddisminuyo ?? 0);
      const stockAnterior = Number(item.detallecuadremanual_stockanterior ?? 0);
      master.set(key, {
        itemId: String(item.item_id ?? ''),
        itemCodigo: item.item_codigo ?? '',
        local,
        almacen: item.almacen?.almacen_descripcion ?? '',
        item: item.descripcionProductoInsumo ?? '',
        tipo: item.tipoItemDescripcion ?? '',
        unidad,
        stockActual: stockAnterior + aumento - disminuyo,
        fecha,
        orden,
      });
    }
  }
  const masterRows = [...master.values()].sort((a, b) => a.local.localeCompare(b.local) || a.almacen.localeCompare(b.almacen) || a.item.localeCompare(b.item));
  const summary = new Map();
  for (const row of masterRows) {
    const key = [row.local, row.itemId, row.unidad].join(':');
    const current = summary.get(key) ?? {
      itemId: row.itemId,
      itemCodigo: row.itemCodigo,
      local: row.local,
      item: row.item,
      unidad: row.unidad,
      almacenes: 0,
      stockActual: 0,
    };
    current.almacenes += 1;
    current.stockActual += row.stockActual;
    summary.set(key, current);
  }
  return {
    filters: cuadres.filters,
    cuadresIncluidos: details.length,
    cuadresEncontrados: cuadres.total,
    paginasConsultadas: cuadres.pages,
    master: masterRows,
    summary: [...summary.values()].sort((a, b) => a.local.localeCompare(b.local) || a.item.localeCompare(b.item)),
  };
}

async function searchItems(page, session, query) {
  const result = await apiPost(page, session.token, '/logistica/rest/common/busqueda/busquedaSensitivaSegunTipos', {
    busqueda: query,
    esInsumo: 1,
    esReceta: 1,
    esPorcionable: 0,
    esDescartable: 0,
    esModificador: 0,
    esCombo: 0,
    esProdTrans: 0,
    esProdNoTrans: 1,
    busqPorCodigo: 0,
    agruparInsumo: 1,
    esDerivado: 0,
    obtenerSoloPreentacionesDeVenta: 0,
    esProdContStock: 0,
    agruparProducto: 0,
    esConsumible: 0,
    local_id: -1,
    proveedor_id: -1,
    esActivo: 0,
    paraArqueo: -1,
  });
  return (Array.isArray(result.data) ? result.data : []).slice(0, 50).map((item) => ({
    id: String(item.item_id),
    type: String(item.item_tipo),
    subtype: item.item_subtipo == null ? null : String(item.item_subtipo),
    name: item.item_descripcion,
    code: item.item_codigo ?? '',
  }));
}

function filterOptions() {
  return {
    estados: [
      { value: '1', label: 'Activo' },
      { value: '0', label: 'Inactivo' },
      { value: '-1', label: 'Todos' },
    ],
    tipos: [
      { value: '-1', label: 'Todos' },
      { value: '0', label: 'Cuadre de stock normal' },
      { value: '1', label: 'Cuadre de stock ciego' },
      { value: '2', label: 'Cuadre de stock por archivo' },
    ],
  };
}

function parseFilters(params) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    locales: params.get('locales') ?? '',
    estado: params.get('estado') ?? '1',
    tipo: Number(params.get('tipo') ?? -1),
    fechaInicio: params.get('fechaInicio') ?? today,
    fechaFin: params.get('fechaFin') ?? today,
    pagina: Math.max(1, Number(params.get('pagina') ?? 1)),
    registros: Math.max(1, Number(params.get('registros') ?? 25)),
    itemIdList: params.get('itemIdList') ?? '',
    itemTipoList: params.get('itemTipoList') ?? '',
  };
}
