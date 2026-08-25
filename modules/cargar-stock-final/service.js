import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, readJsonBody, serveStatic } from '../../lib/http.js';
import { apiGet, apiPost, apiPostRaw, fetchLocals, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/cargar-stock-final';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

const TIPOS_ITEM = [
  { value: '-1', label: 'Todos los tipos' },
  { value: '1', label: 'Insumos' },
  { value: '2', label: 'Productos' },
  { value: '3', label: 'Recetas' },
  { value: '6', label: 'Descartables' },
  { value: '7', label: 'Derivados' },
  { value: '8', label: 'Consumibles' },
];

export async function handleRequest(pathname, url, request, response) {
  if (pathname.startsWith('/api/')) return handleApi(pathname, url, request, response);
  return serveStatic(publicDir, pathname, response);
}

async function handleApi(pathname, url, request, response) {
  try {
    if (pathname === '/api/locals') {
      return json(response, 200, { locals: await withSession(fetchLocals) });
    }
    if (pathname === '/api/tipos') {
      return json(response, 200, { tipos: TIPOS_ITEM });
    }
    if (pathname === '/api/almacenes') {
      const localId = url.searchParams.get('local_id');
      if (!localId) return json(response, 400, { error: 'Falta local_id.' });
      return json(response, 200, { almacenes: await withSession((page, session) => fetchAlmacenes(page, session, localId)) });
    }
    if (pathname === '/api/categorias') {
      return json(response, 200, { categorias: await withSession(fetchCategorias) });
    }
    if (pathname === '/api/items') {
      const filters = parseItemFilters(url.searchParams);
      if (!filters.local_id || !filters.almacen_id) return json(response, 400, { error: 'Falta local_id o almacen_id.' });
      return json(response, 200, { items: await withSession((page, session) => fetchStockParaCuadre(page, session, filters)) });
    }
    if (pathname === '/api/guardar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { local_id: localId, fecha, razon, items } = body ?? {};
      if (!localId || !fecha || !Array.isArray(items)) return json(response, 400, { error: 'Faltan local_id, fecha o items.' });
      const result = await withSession((page, session) => guardarCuadreManualStock(page, session, { localId, fecha, razon, items }));
      return json(response, 200, result);
    }
    if (pathname === '/api/plantillas') {
      const localId = url.searchParams.get('local_id');
      if (!localId) return json(response, 400, { error: 'Falta local_id.' });
      const filtro = {
        pagina: 1,
        locales: localId,
        estado: '1',
        local_id: localId,
        fecha_inicio: -1,
        fecha_fin: -1,
        registros: 100,
        tipo: -1,
        itemIdList: '',
        itemTipoList: '',
      };
      // encodeURIComponent es obligatorio: el base64 puede contener "/", que sin
      // escapar se interpreta como separador de ruta y rompe el enrutamiento del
      // ERP (confirmado con el mismo bug al mapear el módulo de Kardex).
      const filtroCodificado = encodeURIComponent(Buffer.from(JSON.stringify(filtro)).toString('base64'));
      const data = await withSession((page, session) => apiGet(page, session.token, `/logistica/rest/cuadremanual/obtenerListaPlantillacuadre/${filtroCodificado}`));
      return json(response, 200, { plantillas: normalizarListaPlantillas(data) });
    }
    if (pathname === '/api/plantilla' && request.method === 'DELETE') {
      const plantillaId = url.searchParams.get('id');
      if (!plantillaId) return json(response, 400, { error: 'Falta id.' });
      const data = await withSession((page, session) => apiGet(page, session.token, `/logistica/rest/cuadremanual/anularPlantillacuadre/${plantillaId}`));
      return json(response, 200, data);
    }
    if (pathname === '/api/plantilla') {
      const plantillaId = url.searchParams.get('id');
      if (!plantillaId) return json(response, 400, { error: 'Falta id.' });
      const data = await withSession((page, session) => apiGet(page, session.token, `/logistica/rest/cuadremanual/obtenerPlantillacuadre/${plantillaId}`));
      return json(response, 200, normalizarDetallePlantilla(data.data));
    }
    if (pathname === '/api/guardar-plantilla' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const { local_id: localId, fecha, nombre, items, guardarComo } = body ?? {};
      if (!localId || !fecha || !nombre || !Array.isArray(items) || !items.length) {
        return json(response, 400, { error: 'Faltan local_id, fecha, nombre o items.' });
      }
      const modo = guardarComo === 2 ? 2 : 3;
      const result = await withSession((page, session) => guardarPlantillacuadre(page, session, { localId, fecha, nombre, items, guardarComo: modo }));
      return json(response, 200, result);
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

async function fetchCategorias(page, session) {
  const [insumo, receta, producto] = await Promise.all([
    apiGet(page, session.token, '/logistica/rest/producto/insumo/obtenerCategoriaInsumoList'),
    apiGet(page, session.token, '/logistica/rest/producto/receta/obtenerCategoriarecetaList'),
    apiGet(page, session.token, '/logistica/rest/producto/producto/obtenerArbolCategoriasPorLocal/-1'),
  ]);
  const categorias = [{ id: '-1', label: 'Todas' }];
  for (const item of Array.isArray(insumo.data) ? insumo.data : []) {
    categorias.push({ id: `CI-${item.categoriainsumo_id}`, label: item.categoriainsumo_descripcion });
  }
  for (const item of Array.isArray(receta.data) ? receta.data : []) {
    categorias.push({ id: `CR-${item.categoriareceta_id}`, label: item.categoriareceta_descripcion });
  }
  for (const item of Array.isArray(producto.data) ? producto.data : []) {
    categorias.push({ id: `CP-${item.categoria_id}`, label: item.categoria_descripcion });
  }
  return categorias;
}

async function fetchStockParaCuadre(page, session, filters) {
  const payload = {
    busquedaItem: filters.busqueda,
    cuadremanual_fecha: filters.fecha,
    debajoStock: '0',
    ordenarPorCategoria: '0',
    fecha: filters.fecha,
    almacen_id: filters.almacen_id,
    categoria_id: filters.categoria_id,
    tipoProducto: filters.tipo,
    local_id: filters.local_id,
    categoria_idList: filters.categoria_id,
    pagina: 1,
    registros: filters.registros,
  };
  const result = await apiPostRaw(page, session.token, '/logistica/rest/cuadremanual/getStockParaCuadreV2', payload);
  return Array.isArray(result.result) ? result.result : [];
}

// Restaurant Logística NO calcula la variación/aumento/disminución en el backend:
// el frontend real (logistica.html) las precalcula en JS y las manda ya resueltas
// dentro de cada almacén (almacen_variacion, detallecuadremanual_cantidadaumento/
// disminuyo, almacen_valorizacion, existeCambioCosto). Si estos campos no llegan,
// el ERP crea la cabecera del cuadre pero no genera ninguna fila de detalle -- así
// se originaron los cuadres #574 y #575, vacíos. Fórmulas replicadas 1:1 desde el
// bundle minificado de logistica.html (roundCantInventario a 3 decimales,
// roundPriceFinanzas a 2 decimales para Perú).
function calcularCamposAlmacen(almacen) {
  const cantidadAnterior = Number(almacen.cantidad2) || 0;
  const cantidadNueva = Number(almacen.inventario_cantidad) || 0;
  const costoNuevo = Number(almacen.costoNuevo) || 0;
  const variacion = Number((cantidadNueva - cantidadAnterior).toFixed(3));

  const detalle = cantidadNueva > cantidadAnterior
    ? { aumento: (cantidadNueva - cantidadAnterior).toFixed(3), disminuyo: 0 }
    : { aumento: 0, disminuyo: (cantidadAnterior - cantidadNueva).toFixed(3) };

  return {
    ...almacen,
    almacen_variacion: variacion,
    detallecuadremanual_cantidadaumento: detalle.aumento,
    detallecuadremanual_cantidaddisminuyo: detalle.disminuyo,
    almacen_valorizacion: (costoNuevo * cantidadNueva).toFixed(2),
    existeCambioCosto: true,
  };
}

async function guardarCuadreManualStock(page, session, { localId, fecha, razon, items }) {
  const cambiados = items.filter((item) => Array.isArray(item.almacenes) && item.almacenes.some(
    (almacen) => Number(almacen.inventario_cantidad) !== Number(almacen.cantidad2) || Number(almacen.costoNuevo) !== Number(almacen.costo),
  ));
  if (!cambiados.length) throw new Error('No hay ítems con cambios para guardar.');

  const resultConCamposCalculados = cambiados.map((item) => ({
    ...item,
    almacenes: item.almacenes.map(calcularCamposAlmacen),
  }));

  const checksum = `WEB-${localId}-${Math.random().toString(36).slice(2, 11)}-${Date.now()}`;
  const payload = {
    razon: razon ?? '',
    fecha,
    local_id: localId,
    cuadremanual_checksum: checksum,
    result: resultConCamposCalculados,
    guardarComo: 1,
  };

  const result = await apiPost(page, session.token, '/logistica/rest/cuadremanual/guardarCuadreManualStock', payload);

  return { itemsGuardados: cambiados.length, data: result.data ?? null };
}

// Restaurant Logística no tiene un endpoint separado para crear plantillas: el
// mismo guardarCuadreManualStock, con guardarComo=3 ("Solo plantilla"), crea el
// registro de plantilla sin afectar el stock real (no genera cuadre ni movimiento).
// guardarComo=2 ("Plantilla y cuadre") hace ambas cosas a la vez. A diferencia del
// guardado normal (guardarComo=1), aquí se manda la lista COMPLETA de ítems, no
// solo los que cambiaron -- una plantilla es una lista de referencia, no un delta.
async function guardarPlantillacuadre(page, session, { localId, fecha, nombre, items, guardarComo }) {
  const resultConCamposCalculados = items.map((item) => ({
    ...item,
    almacenes: item.almacenes.map(calcularCamposAlmacen),
  }));

  const checksum = `WEB-${localId}-${Math.random().toString(36).slice(2, 11)}-${Date.now()}`;
  const payload = {
    fecha,
    local_id: localId,
    cuadremanual_checksum: checksum,
    nombre,
    result: resultConCamposCalculados,
    guardarComo,
    plantillacuadre_id: null,
    plantillacuadre_fecharegistro: null,
    plantillacuadre_fechaultimouso: null,
    plantillacuadre_estado: '1',
  };

  const result = await apiPost(page, session.token, '/logistica/rest/cuadremanual/guardarCuadreManualStock', payload);

  return { itemsGuardados: resultConCamposCalculados.length, data: result.data ?? null };
}

function normalizarListaPlantillas(response) {
  const data = response?.data;
  const lista = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
  return lista.map((p) => ({
    id: p.plantillacuadre_id,
    nombre: p.plantillacuadre_nombre,
    almacen_id: p.almacen_id,
    almacen_nombre: p.almacen?.almacen_descripcion ?? null,
    fecharegistro: p.plantillacuadre_fecharegistro,
  }));
}

// La respuesta real de obtenerPlantillacuadre trae el registro completo de local/
// usuario/almacén (cientos de campos irrelevantes). Nos quedamos solo con lo que
// necesita "usar plantilla": el almacén al que aplica y, por ítem, la cantidad
// objetivo guardada (detalleplantillacuadre_cantidad).
function normalizarDetallePlantilla(plantilla) {
  if (!plantilla) return null;
  const detalle = Array.isArray(plantilla.detalleplantillacuadreList) ? plantilla.detalleplantillacuadreList : [];
  return {
    id: plantilla.plantillacuadre_id,
    nombre: plantilla.plantillacuadre_nombre,
    local_id: plantilla.local_id,
    almacen_id: plantilla.almacen_id,
    items: detalle.map((d) => ({
      item_id: d.insumo_id ?? d.producto_id,
      item_codigo: d.insumo_codigo ?? d.producto_codigo ?? null,
      item_descripcion: d.detalleplantillacuadre_descripcion,
      cantidad: Number(d.detalleplantillacuadre_cantidad) || 0,
      costo: Number(d.detalleplantillacuadre_costo) || 0,
    })),
  };
}

function parseItemFilters(params) {
  return {
    local_id: params.get('local_id') ?? '',
    almacen_id: params.get('almacen_id') ?? '',
    categoria_id: params.get('categoria_id') ?? '-1',
    tipo: params.get('tipo') ?? '-1',
    busqueda: params.get('busqueda') ?? '',
    fecha: params.get('fecha') ?? new Date().toISOString().slice(0, 19).replace('T', ' '),
    registros: Math.max(1, Number(params.get('registros') ?? 500)),
  };
}
