import { json, readJsonBody, serveStatic } from '../../lib/http.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiGet, apiPost, fetchBinary, fetchLocals, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

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
    if (pathname === '/api/almacenes-todos') {
      return json(response, 200, { almacenes: await withSession(allWarehouses) });
    }
    if (pathname === '/api/tipos-movimiento') {
      return json(response, 200, { tipos: await withSession(movementTypes) });
    }
    if (pathname === '/api/items') {
      const query = String(url.searchParams.get('q') ?? '').trim();
      const localId = String(url.searchParams.get('local_id') ?? '');
      if (query.length < 2 || !/^\d+$/.test(localId)) return json(response, 200, { items: [] });
      return json(response, 200, { items: await withSession((page, session) => items(page, session, query, localId)) });
    }
    if (pathname === '/api/nuevo/guardar' && request.method === 'POST') {
      return json(response, 200, await withSession(async (page, session) => createNewMovement(page, session, await readJsonBody(request))));
    }
    if (pathname === '/api/movimientos') return json(response, 200, await withSession((page, session) => list(page, session, url)));
    const detailMatch = pathname.match(/^\/api\/movimientos\/(\d+)$/);
    if (detailMatch) return json(response, 200, await withSession((page, session) => detail(page, session, detailMatch[1])));
    const cancelMatch = pathname.match(/^\/api\/movimientos\/(\d+)\/anular$/);
    if (cancelMatch && request.method === 'POST') return json(response, 200, await withSession((page, session) => cancel(page, session, cancelMatch[1])));
    const editMatch = pathname.match(/^\/api\/movimientos\/(\d+)\/editar$/);
    if (editMatch && request.method === 'POST') return json(response, 200, await withSession(async (page, session) => edit(page, session, editMatch[1], await readJsonBody(request))));
    if (pathname === '/api/reporte') return withSession((page, session) => report(page, session, url, response));

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

// Mismo tráfico que el editor de Movimiento entre almacenes de Logística:
// CommonCollection.obtenerAlmacenListPorLocal(TODOS, ACTIVO, INACTIVO,
// INACTIVO). Se filtra luego con los locales permitidos que Restaurant entrega
// a la sesión; no se consulta ni persiste catálogo local.
async function allWarehouses(page, session) {
  const [result, locals] = await Promise.all([
    apiGet(page, session.token, '/logistica/rest/common/almacen/getAll/-1/1/0/0'),
    fetchLocals(page, session),
  ]);
  const allowed = new Set(locals.map((local) => String(local.id)));
  return (Array.isArray(result.data) ? result.data : [])
    .filter((row) => allowed.has(String(row.local_id ?? row.local?.local_id ?? '')))
    .map((row) => ({
      id: String(row.almacen_id ?? ''),
      name: String(row.almacen_descripcion ?? ''),
      localId: String(row.local_id ?? row.local?.local_id ?? ''),
      localName: String(row.local?.local_descripcion ?? row.local_descripcion ?? ''),
    }))
    .filter((row) => row.id && row.name && row.localId);
}

async function allWarehouseObjects(page, session) {
  const [result, locals] = await Promise.all([
    apiGet(page, session.token, '/logistica/rest/common/almacen/getAll/-1/1/0/0'),
    fetchLocals(page, session),
  ]);
  const allowed = new Set(locals.map((local) => String(local.id)));
  return (Array.isArray(result.data) ? result.data : [])
    .filter((row) => allowed.has(String(row.local_id ?? row.local?.local_id ?? '')));
}

// Logística no obtiene estas opciones desde un catálogo de datos: las publica
// en el bundle activo como la constante TIPOMOVIMIENTO. Se lee el bundle que
// Restaurant cargó para la sesión actual para no duplicar ni congelar esos
// valores en CRM. El selector nativo usa: 1=Traslado y 2=Devolución.
async function movementTypes(page) {
  const sources = await page.locator('script[src]').evaluateAll((scripts) => scripts.map((script) => script.src).filter(Boolean));
  for (const source of sources) {
    const response = await page.context().request.get(source);
    if (!response.ok()) continue;
    const script = await response.text();
    const match = script.match(/constant\("TIPOMOVIMIENTO",\{TRASLADO:"([^"]+)",DEVOLUCION:"([^"]+)"\}\)/);
    if (!match) continue;
    return [
      { id: match[1], nombre: 'Traslado' },
      { id: match[2], nombre: 'Devolución' },
    ];
  }
  throw new Error('Restaurant no publicó los tipos de movimiento para la sesión actual.');
}

async function items(page, session, query, localId) {
  const result = await apiPost(page, session.token, '/logistica/rest/common/busqueda/busquedaSensitivaSegunTipos', {
    busqueda: query, esInsumo: 1, esReceta: 1, esPorcionable: 1, esDescartable: 1,
    esModificador: 0, esCombo: 1, esProdTrans: 1, esProdNoTrans: 1, busqPorCodigo: 0,
    agruparInsumo: 1, esDerivado: 1, obtenerSoloPreentacionesDeVenta: 0,
    esProdContStock: 0, agruparProducto: 0, esConsumible: 1, local_id: localId,
    proveedor_id: -1, esActivo: 1, paraArqueo: -1,
  });

  return (Array.isArray(result.data) ? result.data : []).slice(0, 30).map((item) => {
    const unit = item.unidadmedidainsumo ?? {};
    return {
      id: String(item.item_id ?? ''), item_tipo: String(item.item_tipo ?? ''), codigo: String(item.item_codigo ?? ''),
      descripcion: String(item.item_descripcion ?? ''), presentacion: String(item.presentacion_nombre ?? item.item_presentacion ?? ''),
      presentacion_id: String(item.presentacion_id ?? item.presentacioninsumo_id ?? item.presentacioncompraproducto_id ?? item.item_presentacionid ?? ''),
      unidadmedida_id: String(item.unidadmedidainsumo_id ?? unit.unidadmedidainsumo_id ?? item.unidadmedida_id ?? ''),
      presentacion_cantidad: item.presentacioninsumo_cantidad ?? item.presentacion_cantidad ?? item.item_presentacioncantidad ?? null,
      unidad: String(item.unidadmedidainsumo_descripcion ?? unit.unidadmedidainsumo_descripcion ?? item.unidadmedida_descripcion ?? item.item_unidadmedida ?? ''),
    };
  }).filter((item) => item.id && item.item_tipo && item.descripcion);
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

/**
 * El panel de detalle consulta Restaurant al abrirse. No reutiliza la fila de
 * la lista porque esa respuesta no contiene los ítems ni los vínculos.
 */
async function detail(page, session, id) {
  const source = await fetchMovement(page, session, id);
  const movement = source.movimiento ?? source;
  const products = Array.isArray(source.productos) ? source.productos : [];
  // obtenerMovimiento devuelve los almacenes y locales vinculados con nombres
  // distintos a los de la grilla. El editor nativo de Restaurant toma estos
  // objetos (no la fila resumida) para hidratar su pantalla.
  const origin = movement.almacenOrigen ?? products[0]?.almacen ?? movement.almacen ?? null;
  const destination = movement.almacenDestino ?? products[0]?.almacenTarget ?? movement.almacenTarget ?? null;
  const destinationLocal = movement.localDestino ?? movement.localTarget ?? null;

  return {
    id: String(movement.movimiento_id ?? id),
    fecha: movement.movimiento_fecha ?? '',
    localOrigen: String(movement.local?.local_descripcion ?? movement.local_descripcion ?? ''),
    almacenOrigen: String(origin?.almacen_descripcion ?? movement.almacen_descripcion ?? ''),
    localDestino: String(destinationLocal?.local_descripcion ?? movement.localdestino_descripcion ?? ''),
    almacenDestino: String(destination?.almacen_descripcion ?? movement.almacen_destino_descripcion ?? ''),
    encargado: String(movement.movimiento_encargado ?? ''),
    receptor: String(movement.movimiento_receptor ?? ''),
    registradoPor: String(movement.usuario_nombrescompletos ?? movement.usuario?.usuario_nick ?? ''),
    estadoCodigo: String(movement.movimiento_estado ?? ''),
    estado: String(movement.estado ?? movement.movimiento_estado ?? ''),
    estadoRecepcionCodigo: String(movement.movimiento_estadorecepcion ?? ''),
    estadoRecepcion: String(movement.estadoRecepcionDescripcion ?? movement.movimiento_estadorecepcion ?? ''),
    observacion: String(movement.movimiento_observacion ?? ''),
    valorizado: products.reduce((total, product) => total + Number(product.valorizado ?? product.item_valorizado ?? 0), 0),
    items: products.map(mapDetailItem),
    guias: mapLinked(movement.guiaremisionList),
    requerimientos: mapLinked(movement.requerimientomovimientoList ?? movement.requerimientoMovimientoList),
    ordenes: mapLinked(movement.solitudmovimientoList ?? movement.ordenmovimientoList),
    mermas: mapLinked(movement.mermaList),
    // Contrato específico del editor. No se expone el objeto crudo de
    // Restaurant: se conserva únicamente lo que la pantalla necesita y lo
    // que puede reenviarse al endpoint actualizarMovimiento.
    editor: {
      local: String(movement.local?.local_descripcion ?? movement.local_descripcion ?? ''),
      localId: String(movement.local_id ?? movement.local?.local_id ?? ''),
      tipo: movementTypeLabel(movement.movimiento_tipomovimiento),
      tipoCodigo: String(movement.movimiento_tipomovimiento ?? ''),
      almacenOrigen: { id: String(origin?.almacen_id ?? ''), nombre: String(origin?.almacen_descripcion ?? '') },
      almacenDestino: { id: String(destination?.almacen_id ?? ''), nombre: String(destination?.almacen_descripcion ?? '') },
      items: products.map(mapEditorItem),
    },
  };
}

async function fetchMovement(page, session, id) {
  const result = await apiGet(page, session.token, `/logistica/rest/movimiento/obtenerMovimiento/${id}`);
  return result.data ?? {};
}

async function cancel(page, session, id) {
  const source = await fetchMovement(page, session, id);
  const movement = source.movimiento ?? source;
  // El listado de Restaurant (la misma acción que usa el ERP) envía la
  // propiedad listProductos de la fila, no el detalle hidratado. Mezclarlos
  // provoca que el backend remoto no resuelva su variable "productos".
  const products = Array.isArray(movement.listProductos) ? movement.listProductos : [];
  const result = await apiPost(page, session.token, '/logistica/rest/movimiento/anularMovimmiento', {
    movimiento: movement,
    productos: products,
  });
  return { ok: true, mensajes: result.mensajes ?? [] };
}

// Restaurant requiere el objeto completo. Por eso la edición parte siempre de
// una lectura nueva y sólo reemplaza los campos modificables del formulario.
async function edit(page, session, id, input) {
  const source = await fetchMovement(page, session, id);
  const movement = source.movimiento ?? source;
  if (String(movement.movimiento_estado ?? '') !== '1') throw new Error('Solo se pueden editar movimientos activos.');
  const detailRows = Array.isArray(source.productos) ? source.productos : [];
  if (!detailRows.length) throw new Error('Restaurant no devolvió ítems para editar este movimiento.');
  const editableItems = mergeEditableItems(detailRows, input.items);
  const warehouseCatalog = await allWarehouseObjects(page, session);
  const types = await movementTypes(page, session);
  const movementType = String(input.tipo_movimiento ?? movement.movimiento_tipomovimiento ?? '');
  if (!types.some((type) => String(type.id) === movementType)) {
    throw new Error('Selecciona un tipo de movimiento vigente en Restaurant.');
  }
  const currentOrigin = detailRows[0].almacen ?? movement.almacenOrigen ?? null;
  const currentDestination = detailRows[0].almacenTarget ?? movement.almacenDestino ?? null;
  const origin = selectedWarehouse(warehouseCatalog, input.almacen_origen, currentOrigin, 'origen');
  const destination = selectedWarehouse(warehouseCatalog, input.almacen_destino, currentDestination, 'destino');
  const next = {
    ...movement,
    // El editor nativo normaliza la fecha a `YYYY-MM-DD HH:mm:ss` antes de
    // llamar a actualizarMovimiento. Filament puede entregar el mismo valor
    // con `T` o sin segundos; ambos se convierten aquí al contrato nativo.
    movimiento_fecha: normalizeMovementDate(input.fecha ?? movement.movimiento_fecha ?? ''),
    movimiento_encargado: String(input.encargado ?? movement.movimiento_encargado ?? ''),
    movimiento_receptor: String(input.receptor ?? movement.movimiento_receptor ?? ''),
    movimiento_observacion: String(input.observacion ?? movement.movimiento_observacion ?? ''),
    movimiento_tipomovimiento: Number(movementType),
    tipoMovimiento: Number(movementType),
    // Estas propiedades transitorias son las que construye la ruta nativa
    // /movimientoalmacen/editar/{id} antes de actualizarMovimiento.
    local_id: String(origin.local_id ?? origin.local?.local_id ?? movement.local_id ?? ''),
    localSeleccionado: origin.local ?? movement.local ?? null,
    almacenOrigenSeleccionado: origin,
    almacenDestinoSeleccionado: destination,
  };
  const products = formatDetailsForRestaurant(editableItems, next);
  // El flujo nativo de Logística primero emula la modificación para calcular
  // los movimientos de stock. Ese resultado se envía luego en
  // `emulacionMovimiento`; omitirlo hace que Restaurant intente resolver su
  // variable interna `productos` y responda literalmente "productos is not
  // defined".
  console.log(`Movimiento ${id}: iniciando emulación (${products.length} detalles).`);
  let emulation;
  try {
    emulation = await apiPost(page, session.token, '/logistica/rest/emulador/emularCambioStockEnMovimientos/2/4', {
      movimiento: next,
      productos: products,
    });
  } catch (error) {
    console.error(`Movimiento ${id}: falló la emulación: ${error.message}`);
    throw error;
  }
  const emulatedMovements = Array.isArray(emulation.data?.movimientos) ? emulation.data.movimientos : [];
  console.log(`Restaurant emulación de movimiento ${id}: ${products.length} detalles, ${emulatedMovements.length} movimientos de stock.`);
  console.log(`Movimiento ${id}: enviando actualización (${emulatedMovements.length} movimientos emulados).`);
  let result;
  try {
    result = await apiPost(page, session.token, '/logistica/rest/movimiento/actualizarMovimiento', {
      movimiento: next,
      productos: products,
      emulacionMovimiento: emulatedMovements,
    });
  } catch (error) {
    console.error(`Movimiento ${id}: falló la actualización: ${error.message}`);
    throw error;
  }
  return { ok: true, mensajes: result.mensajes ?? [] };
}

async function createNewMovement(page, session, input) {
  if (input.confirmar !== true) throw new Error('Confirma el guardado antes de registrar el movimiento.');
  const { movement, products } = await buildNewMovement(page, session, input);
  const validation = await apiPost(page, session.token, '/logistica/rest/movimiento/validarItemConControlDeStockEnAlmacenes', products);
  if (String(validation.data ?? '') !== '0') {
    throw new Error(firstMessage(validation) || 'Restaurant detectó un problema de stock en los ítems seleccionados.');
  }
  const emulation = await apiPost(page, session.token, '/logistica/rest/emulador/emularCambioStockEnMovimientos/2/4', {
    movimiento: movement,
    productos: products,
  });
  const data = emulation.data ?? {};
  if (data.operacionRestringidaPorStockNegativo) throw new Error('Restaurant restringió el movimiento porque dejaría stock negativo.');
  const result = await apiPost(page, session.token, '/logistica/rest/movimiento/agregar', {
    movimiento: movement,
    productos: products,
    emulacionMovimiento: Array.isArray(data.movimientos) ? data.movimientos : [],
  });
  return { ok: true, id: String(result.data?.movimiento_id ?? result.data?.id ?? ''), mensajes: result.mensajes ?? [] };
}

async function buildNewMovement(page, session, input) {
  const warehouses = await allWarehouseObjects(page, session);
  const types = await movementTypes(page, session);
  const localId = String(input.local_id ?? '');
  const origin = selectedWarehouse(warehouses, input.almacen_origen, null, 'origen');
  const destination = selectedWarehouse(warehouses, input.almacen_destino, null, 'destino');
  const allowedLocals = new Set((await fetchLocals(page, session)).map((local) => String(local.id)));
  if (!allowedLocals.has(localId) || String(origin.local_id ?? origin.local?.local_id ?? '') !== localId) {
    throw new Error('El almacén de origen no corresponde a un local permitido.');
  }
  if (String(origin.almacen_id) === String(destination.almacen_id)) throw new Error('El almacén de origen y destino deben ser distintos.');
  const encargado = String(input.encargado ?? '').trim();
  if (!encargado) throw new Error('Registra un encargado del envío antes de agregar ítems.');
  const items = Array.isArray(input.items) ? input.items : [];
  if (!items.length) throw new Error('Agrega al menos un ítem al movimiento.');
  const movementType = String(input.tipo_movimiento ?? '');
  if (!types.some((type) => type.id === movementType)) throw new Error('Selecciona un tipo de movimiento vigente en Restaurant.');
  const local = origin.local ?? { local_id: localId, local_descripcion: String(origin.local_descripcion ?? '') };
  const movement = {
    movimiento_id: null,
    conGuia: '0',
    numerodoc: null,
    localSeleccionado: local,
    local_id: localId,
    movimiento_checksum: `WEB-${localId}-${Math.random().toString(36).slice(2, 11)}-${Date.now()}`,
    movimiento_fecha: normalizeMovementDate(input.fecha),
    movimiento_encargado: encargado,
    movimiento_receptor: String(input.receptor ?? '').trim(),
    movimiento_observacion: String(input.observacion ?? '').trim(),
    movimiento_tipomovimiento: Number(movementType),
    tipoMovimiento: Number(movementType),
    almacenOrigenSeleccionado: origin,
    almacenDestinoSeleccionado: destination,
  };
  if (!movement.movimiento_fecha) throw new Error('Selecciona una fecha de movimiento válida.');
  const products = formatDetailsForRestaurant(items.map((item) => ({
    ...item,
    item_cantidad: item.cantidad_a_mover ?? item.cantidad,
    item_cantidad_original: item.cantidad_a_mover ?? item.cantidad,
  })), movement).filter((item) => Number(item.detallemovimiento_cantidad) > 0);
  if (!products.length) throw new Error('Cada ítem debe tener una cantidad mayor a cero.');
  return { movement, products };
}

function firstMessage(result) {
  const messages = result?.mensajes;
  return Array.isArray(messages) ? String(messages[0] ?? '') : String(messages ?? '');
}

function normalizeMovementDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return raw;
  const normalized = raw.replace('T', ' ');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) return `${normalized}:00`;
  return normalized;
}

function selectedWarehouse(catalog, requestedId, fallback, label) {
  const id = String(requestedId ?? fallback?.almacen_id ?? '');
  const selected = catalog.find((warehouse) => String(warehouse.almacen_id) === id);
  if (!selected) throw new Error(`El almacén de ${label} ya no está disponible para tu sesión en Restaurant.`);
  return selected;
}

function mergeEditableItems(rows, inputItems) {
  if (!Array.isArray(inputItems)) return rows;
  const existing = new Map(rows.map((row) => [String(row.detallemovimiento_id ?? row.id ?? ''), row]));
  const merged = [];

  for (const input of inputItems) {
    if (!input || typeof input !== 'object') continue;
    const id = String(input.id ?? '');
    const quantity = Number(input.cantidad_a_mover ?? input.cantidad);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('Cada ítem debe tener una cantidad válida.');

    if (id && existing.has(id)) {
      const row = existing.get(id);
      merged.push({ ...row, item_cantidad: quantity, detallemovimiento_cantidad: quantity });
      continue;
    }

    const itemId = String(input.item_id ?? '');
    const itemType = Number(input.item_tipo ?? 0);
    if (!itemId || !Number.isFinite(itemType) || itemType <= 0) throw new Error('Selecciona un ítem válido para cada nueva fila.');
    merged.push({
      item_id: itemId,
      item_tipo: itemType,
      item_codigo: String(input.codigo ?? ''),
      item_descripcion: String(input.descripcion ?? ''),
      presentacion_id: input.presentacion_id ?? null,
      presentacion_nombre: String(input.presentacion ?? ''),
      unidadmedidainsumo_id: input.unidadmedida_id ?? null,
      unidadmedida_descripcion: String(input.unidad ?? ''),
      presentacioninsumo_cantidad: input.presentacion_cantidad ?? null,
      item_cantidad: quantity,
      item_cantidad_original: quantity,
      detallemovimiento_id: null,
    });
  }

  if (!merged.length) throw new Error('El movimiento debe conservar al menos un ítem.');
  return merged;
}

// Réplica acotada de Movimiento.obtenerFormatoDetalleMovimientoBackend() del
// frontend de Logística. El endpoint no admite los objetos de detalle tal como
// los entrega obtenerMovimiento: requiere estas claves de persistencia.
function formatDetailsForRestaurant(rows, movement) {
  const origin = movement.almacenOrigenSeleccionado;
  const destination = movement.almacenDestinoSeleccionado;
  if (!origin?.almacen_id || !destination?.almacen_id) throw new Error('Restaurant no devolvió los almacenes del movimiento.');

  return rows
    .filter((row) => Number(row.item_cantidad ?? row.detallemovimiento_cantidad ?? 0) >= 0)
    .map((row) => {
      const itemType = Number(row.item_tipo ?? row.tipo ?? 0);
      const itemId = String(row.item_id ?? '');
      const unit = normalizedUnit(row);
      const detail = {
        detallemovimiento_descripcion: row.item_descripcion ?? row.detallemovimiento_descripcion ?? '',
        detallemovimiento_unidadmedida: unit,
        detallemovimiento_cantidad: Number(row.item_cantidad ?? row.detallemovimiento_cantidad ?? 0),
        detallemovimiento_cantidadsolicitada: row.item_cantidad_original ?? row.detallemovimiento_cantidadsolicitada ?? null,
        movimiento_id: String(movement.movimiento_id ?? '-1'),
        detallemovimiento_id: row.detallemovimiento_id ?? null,
        tipo: itemType,
        unidadmedidainsumo: row.unidadmedidainsumo_id ?? null,
        almacenSeleccionado: origin,
        almacen_id: String(origin.almacen_id),
        detallemovimiento_almacendestinoid: String(destination.almacen_id),
        detallemovimiento_almacenorigenid: String(origin.almacen_id),
        detallemovimiento_observacion: row.item_observacion || null,
      };
      if (itemType === 2) {
        detail.producto_id = itemId;
        detail.insumo_id = null;
        detail.producto_codigo = itemId;
        if (Number(row.presentacion_id ?? 0) > 0) {
          detail.presentacioncompraproducto_id = row.presentacion_id;
          detail.detallemovimiento_descripcion = `${detail.detallemovimiento_descripcion} - ${row.presentacion_nombre ?? ''}`.trim();
        }
      } else {
        detail.insumo_id = itemId;
        detail.producto_id = null;
        detail.producto_codigo = row.item_codigo ?? '';
        detail.presentacioninsumo_id = row.presentacion_id ?? null;
        detail.presentacioninsumo_cantidad = row.presentacioninsumo_cantidad ?? row.presentacion_cantidad ?? null;
      }
      return detail;
    });
}

// El objeto de unidad que entrega obtenerMovimiento es parte del detalle que
// Logística reenvía. Para ítems nuevos el formulario sólo conserva sus campos
// visibles, así que reconstruimos ese objeto desde el catálogo vivo sin usar
// una unidad fija ni depender de la BD del CRM.
function normalizedUnit(row) {
  if (row.unidadmedidainsumo && typeof row.unidadmedidainsumo === 'object') return row.unidadmedidainsumo;
  const id = row.unidadmedidainsumo_id ?? row.unidadmedida_id ?? null;
  const description = row.unidadmedida_descripcion ?? row.unidad ?? '';
  if (id == null && !description) return null;
  return {
    unidadmedidainsumo_id: id == null ? null : String(id),
    unidadmedidainsumo_descripcion: String(description),
    unidadmedidainsumo_sigla: String(row.presentacion_nombre ?? row.presentacion ?? ''),
  };
}

async function report(page, session, url, response) {
  const id = String(url.searchParams.get('id') ?? '');
  const variant = String(url.searchParams.get('variant') ?? 'normal');
  if (!/^\d+$/.test(id) || !['normal', 'sin_costos'].includes(variant)) return json(response, 400, { error: 'Reporte no válido.' });
  const query = new URLSearchParams({ page: 'detalleindividual_logistica_movimientointernoPDF', or: 'P', type: 'pdf', margen: '10', footer: '1', movimiento_id: id, name: `movimiento${id}`, token: session.token });
  if (variant === 'sin_costos') query.set('ocultarcostos', '1');
  const file = await fetchBinary(page, `https://img.restpe.com/api/reports/report.php?${query}`);
  response.writeHead(200, { 'Content-Type': file.contentType, 'Content-Disposition': `attachment; filename="movimiento-${id}${variant === 'sin_costos' ? '-sin-costos' : ''}.pdf"` });
  response.end(file.buffer);
}

function mapDetailItem(item) {
  return {
    id: String(item.detallemovimiento_id ?? item.id ?? ''),
    codigo: String(item.item_codigo ?? ''),
    item: String(item.item_descripcion ?? item.descripcion ?? ''),
    presentacion: String(item.presentacion_nombre ?? item.item_presentacion ?? ''),
    cantidad: Number(item.item_cantidad ?? item.detallemovimiento_cantidad ?? 0),
    unidad: String(item.unidadmedida_descripcion ?? item.item_unidadmedida ?? ''),
    almacenOrigen: String(item.almacen?.almacen_descripcion ?? item.almacen_descripcion ?? ''),
    almacenDestino: String(item.almacenTarget?.almacen_descripcion ?? item.almacen_destino_descripcion ?? ''),
    valorizado: Number(item.valorizado ?? item.item_valorizado ?? 0),
  };
}

function mapEditorItem(item) {
  return {
    id: String(item.detallemovimiento_id ?? item.id ?? ''),
    itemId: String(item.item_id ?? item.producto_id ?? item.insumo_id ?? ''),
    itemTipo: String(item.item_tipo ?? item.tipo ?? ''),
    codigo: String(item.item_codigo ?? ''),
    descripcion: String(item.item_descripcion ?? item.descripcion ?? ''),
    presentacion: String(item.presentacion_nombre ?? item.item_presentacion ?? ''),
    presentacionId: String(item.presentacion_id ?? item.presentacioninsumo_id ?? item.presentacioncompraproducto_id ?? item.item_presentacionid ?? ''),
    unidadmedidaId: String(item.unidadmedidainsumo_id ?? item.unidadmedidainsumo?.unidadmedidainsumo_id ?? item.unidadmedida_id ?? ''),
    presentacionCantidad: item.presentacioninsumo_cantidad ?? item.presentacion_cantidad ?? item.item_presentacioncantidad ?? null,
    cantidad: Number(item.item_cantidad ?? item.detallemovimiento_cantidad ?? 0),
    unidad: String(item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? item.unidadmedida_descripcion ?? item.item_unidadmedida ?? ''),
  };
}

function movementTypeLabel(value) {
  const code = String(value ?? '');
  if (code === '1') return 'Traslado';
  if (code === '2') return 'Devolución';
  return code || 'Sin especificar';
}

function mapLinked(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.guiaremision_id ?? row.requerimientomovimiento_id ?? row.solitudmovimiento_id ?? row.ordenmovimiento_id ?? row.merma_id ?? row.id ?? ''),
    descripcion: String(row.descripcion ?? row.guiaremision_serie ?? row.requerimientomovimiento_codigo ?? row.solitudmovimiento_codigo ?? row.merma_codigo ?? ''),
    estado: String(row.estado ?? row.guiaremision_estado ?? row.requerimientomovimiento_estado ?? row.solitudmovimiento_estado ?? row.merma_estado ?? ''),
  })).filter((row) => row.id || row.descripcion);
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
