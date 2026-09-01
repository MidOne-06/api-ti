import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, readJsonBody, serveStatic } from '../../lib/http.js';
import { apiGet, apiPost, fetchLocals, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/requerimientos-stock';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

export async function handleRequest(pathname, url, request, response) {
  if (pathname.startsWith('/api/')) return handleApi(pathname, url, request, response);
  return serveStatic(publicDir, pathname, response);
}

async function handleApi(pathname, url, request, response) {
  try {
    if (pathname === '/api/locals') {
      return json(response, 200, { locals: await withSession(fetchLocals) });
    }
    if (pathname === '/api/almacenes') {
      const localId = url.searchParams.get('local_id');
      if (!localId) return json(response, 400, { error: 'Falta local_id.' });
      return json(response, 200, { almacenes: await withSession((page, session) => fetchAlmacenes(page, session, localId)) });
    }
    if (pathname === '/api/items') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      return json(response, 200, { items: query ? await withSession((page, session) => searchItems(page, session, query)) : [] });
    }
    if (pathname === '/api/lista') {
      return json(response, 200, await withSession((page, session) => listarRequerimientos(page, session, url)));
    }
    if (pathname === '/api/detalle') {
      const id = url.searchParams.get('id');
      if (!/^\d+$/.test(String(id))) return json(response, 400, { error: 'Código de requerimiento inválido.' });
      return json(response, 200, await withSession((page, session) => obtenerDetalleRequerimiento(page, session, id)));
    }
    if (pathname === '/api/historial') {
      const id = url.searchParams.get('id');
      if (!/^\d+$/.test(String(id))) return json(response, 400, { error: 'Código de requerimiento inválido.' });
      return json(response, 200, await withSession((page, session) => obtenerHistorialRequerimiento(page, session, id)));
    }
    if (pathname === '/api/acciones/aprobar' && request.method === 'POST') {
      const { id } = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => aprobarRequerimiento(page, session, id)));
    }
    if (pathname === '/api/acciones/rechazar' && request.method === 'POST') {
      const { id, motivo } = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => rechazarRequerimiento(page, session, id, motivo)));
    }
    if (pathname === '/api/acciones/anular' && request.method === 'POST') {
      const { id } = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => anularRequerimiento(page, session, id)));
    }
    if (pathname === '/api/plantillas') {
      return json(response, 200, await withSession((page, session) => listarPlantillas(page, session, url)));
    }
    if (pathname === '/api/plantillas/importar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => importarPlantilla(page, session, body)));
    }
    if (pathname === '/api/guardar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      const result = await withSession((page, session) => guardarRequerimiento(page, session, body));
      return json(response, 200, result);
    }
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: error.message || 'No se pudo consultar Logística. Intenta nuevamente.' });
  }
}

async function listarPlantillas(page, session, url) {
  const localId = String(url.searchParams.get('local_id') ?? session.localId ?? '');
  const pageNumber = Math.max(1, Number.parseInt(url.searchParams.get('pagina') ?? '1', 10) || 1);
  const records = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get('registros') ?? '25', 10) || 25));
  const encoded = Buffer.from(JSON.stringify({ local_id: localId, pagina: pageNumber, registros: records })).toString('base64');
  const result = await apiGet(page, session.token, `/logistica/rest/requerimientomovimiento/obtenerPlantillaRequerimientoPorLocal/${encodeURIComponent(encoded)}`);
  const rows = Array.isArray(result.data) ? result.data : [];
  return {
    total: Number(result.totalCount ?? rows.length),
    rows: rows.map((template) => ({
      id: String(template.plantillarequerimiento_id),
      nombre: template.plantillarequerimiento_nombre ?? '',
      encargado: template.plantillarequerimiento_encargado ?? '',
      receptor: template.plantillarequerimiento_receptor ?? '',
      observacion: template.plantillarequerimiento_observacion ?? '',
      local_origen: template.local?.local_descripcion ?? '',
      local_origen_id: String(template.local?.local_id ?? template.local_id ?? ''),
      local_produccion: template.localproduccion?.local_descripcion ?? '',
      local_produccion_id: String(template.localproduccion?.local_id ?? template.plantillarequerimiento_localproduccionid ?? ''),
      recetas: sanitizeTemplateDetails(template.detalle_recetas),
      insumos: sanitizeTemplateDetails(template.detalle_insumos),
      productos: sanitizeTemplateDetails(template.detalle_productos),
    })),
  };
}

async function importarPlantilla(page, session, body) {
  const id = String(body.templateId ?? '');
  if (!/^\d+$/.test(id)) throw new Error('Selecciona una plantilla válida.');
  const omitZero = body.incluirCantidadesCero ? '0' : '1';
  const result = await apiPost(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/obtenerPlantillarequerimientoParaImportar/${omitZero}`,
    [id],
  );
  return sanitizeImportedTemplate(result.data ?? {});
}

function sanitizeTemplateDetails(items) {
  return (Array.isArray(items) ? items : []).filter((item) => item?.item_id).map((item) => ({
    id: String(item.item_id),
    codigo: item.item_codigo ?? '',
    descripcion: item.item_descripcion ?? '',
    presentacion: item.presentacion_nombre ?? item.item_presentacion ?? '',
    cantidad: Number(item.item_cantidad ?? 0),
    unidad: item.unidadmedida_descripcion_unidad ?? item.unidadmedidainsumo_descripcion ?? '',
  }));
}

function sanitizeImportedTemplate(data) {
  const template = Array.isArray(data.plantillarequerimientoList) ? data.plantillarequerimientoList[0] : null;
  const details = Array.isArray(data.detalleplantillarequerimientoList) ? data.detalleplantillarequerimientoList : [];
  if (!template) throw new Error('No se pudo obtener el contenido de la plantilla seleccionada.');
  return {
    id: String(template.plantillarequerimiento_id),
    localOrigenId: String(template.local?.local_id ?? template.local_id ?? ''),
    localDestinoId: String(template.localproduccion?.local_id ?? template.plantillarequerimiento_localproduccionid ?? ''),
    encargado: template.plantillarequerimiento_encargado ?? '',
    receptor: template.plantillarequerimiento_receptor ?? '',
    observacion: template.plantillarequerimiento_observacion ?? '',
    items: details.filter((item) => item?.item_id).map((item) => ({ item: toImportableItem(item), cantidad: Number(item.item_cantidad ?? 0) })),
  };
}

// El detalle de Logística contiene árboles grandes de relaciones. El formulario
// solo necesita estos datos para mostrar el ítem y formar el payload de guardado.
function toImportableItem(item) {
  const unitId = item.unidadmedidainsumo_id ?? item.unidadmedidainsumo?.unidadmedidainsumo_id ?? 1;
  const unitName = item.unidadmedida_descripcion_unidad ?? item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? '';
  return {
    item_id: String(item.item_id),
    item_tipo: String(item.item_tipo ?? 1),
    item_codigo: item.item_codigo ?? '',
    item_descripcion: item.item_descripcion ?? item.item_descripcion_original ?? '',
    item_presentacionid: String(item.presentacioninsumo_id ?? item.presentacioncompraproducto_id ?? item.presentacion_id ?? ''),
    item_presentacion: item.item_presentacion ?? item.presentacion_nombre ?? '',
    unidadmedidainsumo_id: String(unitId),
    unidadmedidainsumo_descripcion: unitName,
    unidadmedidainsumo: { unidadmedidainsumo_id: String(unitId), unidadmedidainsumo_descripcion: unitName },
  };
}

// Consulta de solo lectura que utiliza exactamente la misma fuente que el
// listado "Requerimientos de stock" de Restaurant.pe. El ERP recibe los
// filtros serializados en base64 dentro de la ruta, no como query-string.
async function listarRequerimientos(page, session, url) {
  const locales = await fetchLocals(page, session);
  const allowedIds = new Set(locales.map((local) => String(local.id)));
  const parseIds = (key) => (url.searchParams.get(key) ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => allowedIds.has(id));
  const selectedLocals = parseIds('locales');
  const selectedProductionLocals = parseIds('locales_produccion');
  const selectedItems = (url.searchParams.get('items') ?? '')
    .split(',')
    .map((value) => value.split(':'))
    .filter(([id, type]) => /^\d+$/.test(id) && /^\d+$/.test(type))
    .slice(0, 5)
    .map(([id, tipo]) => ({ id, tipo }));
  const allIds = [...allowedIds];
  const pageNumber = Math.max(1, Number.parseInt(url.searchParams.get('pagina') ?? '1', 10) || 1);
  const records = Math.min(100, Math.max(10, Number.parseInt(url.searchParams.get('registros') ?? '25', 10) || 25));
  const dateStart = normalizeDate(url.searchParams.get('fecha_inicio'), false);
  const dateEnd = normalizeDate(url.searchParams.get('fecha_fin'), true);
  const filters = {
    pagina: pageNumber,
    locales: (selectedLocals.length ? selectedLocals : allIds).join('-'),
    listaInsumoProducto: selectedItems.length ? selectedItems : null,
    listaInsumoProductoSeleccionados: [],
    estado: Number.parseInt(url.searchParams.get('estado') ?? '-1', 10),
    buscarSegunLocalProduce: 1,
    local_id: String(session.localId ?? allIds[0] ?? ''),
    fecha_inicio: dateStart,
    fecha_fin: dateEnd,
    registros: records,
    searchCodUnico: (url.searchParams.get('codigo') ?? '').trim(),
    encargado: (url.searchParams.get('encargado') ?? '').trim(),
    localesProduccion: (selectedProductionLocals.length ? selectedProductionLocals : allIds).join('-'),
    porFecha: Number.parseInt(url.searchParams.get('por_fecha') ?? '0', 10) === 1 ? 1 : 0,
  };
  const encoded = Buffer.from(JSON.stringify(filters)).toString('base64');
  const result = await apiGet(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/obtenerListaDeRequerimientosPorUrlEncodeada/${encodeURIComponent(encoded)}?readonly=true&sobreEscribirRedis=0`,
  );
  const payload = result.data ?? {};
  const rows = Array.isArray(payload.result) ? payload.result : (Array.isArray(payload) ? payload : []);
  // Algunas respuestas históricas del ERP no exponen totalCount: en ese caso
  // se muestra el mínimo comprobable (las filas de la página actual).
  const total = Number(result.totalregistros ?? payload.totalregistros ?? payload.totalCount ?? result.totalCount ?? rows.length);
  return { filters, total, rows: rows.map(mapRequirement) };
}

// Fuente que utiliza la vista de resumen de Restaurant.pe. Se conservan la
// cabecera y el detalle reales, sin reconstruirlos a partir del listado.
async function obtenerDetalleRequerimiento(page, session, id) {
  const result = await apiGet(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/obtenerDetalleRequerimientoPorRequerimientoId/${encodeURIComponent(id)}`,
  );
  const data = result.data ?? {};
  const cabecera = data.result_requerimiento ?? data.requerimientomovimiento ?? {};
  const detalles = Array.isArray(data.result_detalle) ? data.result_detalle : (Array.isArray(data.detallerequerimiento) ? data.detallerequerimiento : []);
  const estadoCode = firstValue(cabecera, ['requerimientomovimiento_estado']);
  const estado = firstValue(cabecera.estado ?? {}, ['estado_descripcion'], firstValue(cabecera, ['requerimientomovimiento_estadoDescripcion', 'estado_descripcion']))
    || ({ '0': 'Anulado', '1': 'Pendiente', '2': 'Aprobado', '3': 'Rechazado', '4': 'Atendido' }[String(estadoCode)] ?? estadoCode);

  return {
    cabecera: {
      codigo: firstValue(cabecera, ['requerimientomovimiento_id', 'id']),
      fecha_registro: firstValue(cabecera, ['requerimientomovimiento_fecharegistro']),
      fecha_abastecimiento: firstValue(cabecera, ['requerimientomovimiento_fecha']),
      solicitado_por: firstValue(cabecera.localSolicitante ?? {}, ['local_descripcion'], firstValue(cabecera, ['local_origen', 'local_descripcion'])),
      local_produccion: firstValue(cabecera.localProduccion ?? {}, ['local_descripcion'], firstValue(cabecera, ['local_produccion', 'localproduccion_descripcion'])),
      encargado: firstValue(cabecera, ['requerimientomovimiento_encargado']),
      receptor: firstValue(cabecera, ['requerimientomovimiento_receptor']),
      estado,
      observacion: firstValue(cabecera, ['requerimientomovimiento_observacion']),
    },
    // Se entrega el origen íntegro para que CRM pueda preservar todos los
    // datos recuperados, aunque la vista solo utilice el mapeo normalizado.
    origen_restaurant: { cabecera, detalles },
    detalles: detalles.filter((detalle) => detalle?.item_id).map((detalle) => ({
      erp_detalle_id: firstValue(detalle, ['detallerequerimiento_id']),
      codigo: firstValue(detalle, ['item_codigo']),
      item: firstValue(detalle, ['item_descripcion_completa', 'item_descripcion', 'producto_descripcion', 'nombreProducto']),
      categoria: firstValue(detalle, ['item_categoria'], firstValue(detalle.categoria ?? {}, ['categoriareceta_descripcion'])),
      presentacion: firstValue(detalle, ['item_presentacion'], firstValue(detalle.presentacion ?? {}, ['presentacioninsumo_nombre', 'presentacion_nombre'])),
      cantidad_solicitada: Number(detalle.detallerequerimiento_cantidad ?? detalle.item_cantidad ?? 0),
      cantidad_despachada: Number(detalle.detallerequerimiento_cantidaddespachada ?? 0),
      cantidad_preparada: Number(detalle.detallerequerimiento_cantidadpreparada ?? 0),
      unidad: firstValue(detalle, ['detallerequerimiento_um', 'producto_unidadmedida'], firstValue(detalle.unidadmedidainsumo ?? {}, ['unidadmedidainsumo_descripcion'])),
      almacen: firstValue(detalle.almacenDestino ?? {}, ['almacen_descripcion']),
      observacion: firstValue(detalle, ['detallerequerimiento_observacion', 'item_observacion']),
      payload_restaurant: detalle,
    })),
  };
}

// Historial nativo de Restaurant.pe. Se mantiene separado de las
// sincronizaciones locales: el primero describe las acciones de usuarios en
// Restaurant; el segundo acredita cuándo CRM actualizó su copia de consulta.
async function obtenerHistorialRequerimiento(page, session, id) {
  const result = await apiGet(
    page,
    session.token,
    `/logistica/rest/common/obtenerHistoricoCambios/REQUERIMIENTOMOVIMIENTO/${encodeURIComponent(id)}`,
  );

  return {
    eventos: (Array.isArray(result.data) ? result.data : []).map((evento) => {
      const source = sanitizeRemoteData(evento);

      return {
        fecha: firstValue(source, ['historicocambio_fecharegistro', 'historicocambio_fecha', 'fecha', 'created_at']),
        evento: firstValue(source, ['historicocambio_descripcion', 'historicocambio_accion', 'descripcion', 'accion', 'mensaje']),
        usuario: firstValue(source.usuario ?? {}, ['usuario_nick', 'usuario_nombre'], firstValue(source, ['usuario_nick', 'usuario_nombre', 'usuario'])),
        origen_restaurant: source,
      };
    }),
  };
}

function requirementId(id) {
  const value = String(id ?? '').trim();
  if (!/^\d+$/.test(value)) throw new Error('Código de requerimiento inválido.');
  return value;
}

function actionResult(result) {
  return {
    ok: true,
    mensajes: Array.isArray(result.mensajes) ? result.mensajes : [],
  };
}

async function aprobarRequerimiento(page, session, id) {
  const result = await apiGet(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/requerimientomovimiento/aprobar/${requirementId(id)}`,
  );

  return actionResult(result);
}

async function rechazarRequerimiento(page, session, id, motivo) {
  const reason = String(motivo ?? '').trim();
  if (!reason) throw new Error('Indica el motivo del rechazo.');

  const result = await apiPost(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/requerimientomovimiento/rechazar/${requirementId(id)}`,
    { motivo: reason.slice(0, 80) },
  );

  return actionResult(result);
}

async function anularRequerimiento(page, session, id) {
  const result = await apiGet(
    page,
    session.token,
    `/logistica/rest/requerimientomovimiento/anularRequerimientoMovimiento/${requirementId(id)}`,
  );

  return actionResult(result);
}

function normalizeDate(value, endOfDay) {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  return raw || `${new Date().toISOString().slice(0, 10)} ${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function firstValue(row, keys, fallback = '') {
  for (const key of keys) {
    if (row[key] != null && row[key] !== '') return row[key];
  }
  return fallback;
}

function mapRequirement(row) {
  const linked = buildLinkedDocuments(row);
  return {
    codigo: firstValue(row, ['requerimientomovimiento_id', 'id', 'codigo']),
    fecha_registro: firstValue(row, ['requerimientomovimiento_fecharegistro', 'fecha_registro']),
    fecha_abastecimiento: firstValue(row, ['requerimientomovimiento_fecha', 'fecha']),
    solicitado_por: firstValue(row, ['local_origen', 'local_descripcion', 'local_nombre', 'solicitado_por']),
    local_produccion: firstValue(row, ['local_produccion', 'localproduccion_descripcion', 'local_destino_descripcion']),
    encargado: firstValue(row, ['requerimientomovimiento_encargado', 'encargado']),
    receptor: firstValue(row, ['requerimientomovimiento_receptor', 'receptor']),
    movimiento: linked.movimiento,
    proceso_produccion: firstValue(row, ['loterequerimiento_id', 'procesoproduccion_codigo', 'proceso_produccion']),
    otros_documentos: linked.otros,
    estado_despacho: firstValue(row, ['requerimientomovimiento_estadoDespacho', 'estado_despacho']),
    estado: firstValue(row, ['requerimientomovimiento_estadoDescripcion', 'requerimientomovimiento_estado_descripcion', 'estado_descripcion', 'estado']),
    fecha_aprobacion: firstValue(row, ['ultimaFechaAprobacion', 'fecha_aprobacion']),
  };
}

function buildLinkedDocuments(row) {
  const movementId = firstValue(row, ['movimiento_id', 'requerimientomovimiento_movimientoid']);
  const movements = Array.isArray(row.movimientoList) ? row.movimientoList.map((item) => item.movimiento_id).filter(Boolean) : [];
  const movimiento = movementId || (movements.length === 1 ? movements[0] : '');
  const groups = [
    ['M', movements.length > 1 ? movements : []],
    ['SC', (row.solicitudcompraList ?? []).map((item) => item.requerimientocompra_id)],
    ['GI', (row.guiaremisionList ?? []).map((item) => item.guiaremision_id)],
    ['GV', (row.guiaventaList ?? []).map((item) => item.guiaremision_id)],
  ].filter(([, ids]) => ids.length).map(([prefix, ids]) => `${prefix} ${ids.map((id) => `#${id}`).join(', ')}`);
  return { movimiento, otros: groups.join(', ') };
}

// Devuelve los objetos "local" crudos tal como los entrega Logística (no la
// versión remapeada de restaurant-session.js#toLocalDetail) -- el guardado
// de un requerimiento reenvía estos mismos objetos completos como parte del
// payload (localSeleccionado/localDestinoSeleccionado/localDestinoList), así
// que deben viajar con exactamente los mismos nombres de campo que trajeron.
async function fetchRawLocals(page, session) {
  const result = await apiGet(page, session.token, `/logistica/rest/producto/local/obtenerLocalesPermitidosParaUsuarioID/${session.userId}`);
  return Array.isArray(result.data) ? result.data : [];
}

// Igual que el caso anterior: el almacén seleccionado viaja completo y crudo
// dentro del payload de guardado (almacenSeleccionado/almacenDestinoList).
async function fetchRawAlmacenes(page, session, localId) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/almacen/getAll/${localId}/1/0/0`);
  return Array.isArray(result.data) ? result.data : [];
}

async function fetchAlmacenes(page, session, localId) {
  const almacenes = await fetchRawAlmacenes(page, session, localId);
  return almacenes
    .filter((almacen) => String(almacen.almacen_controlstock) === '1')
    .map((almacen) => ({ id: String(almacen.almacen_id), nombre: almacen.almacen_descripcion }));
}

// A diferencia de cuadres-stock/kardex (que solo extraen id/nombre), aquí se
// devuelve el objeto crudo completo: el guardado necesita presentacion_id,
// unidadmedidainsumo_id y demás campos que el buscador ya trae, y no vale la
// pena volver a adivinarlos a mano tras el costo de las 7 pruebas fallidas
// anteriores contra producción.
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
  return (Array.isArray(result.data) ? result.data : []).slice(0, 50);
}

function pad(date, length) {
  return String(date).padStart(length, '0');
}

// Replica vm.rangoFechaDeMovimiento tal como viaja en un guardado real
// capturado con DevTools -- Logística devolvía "fecha no válida" para
// cualquier otro formato probado (ISO, timestamp, solo fecha, etc.) antes de
// tener esta captura real de referencia.
// Lima no observa horario de verano -- UTC-5 fijo. La captura real confirma
// este offset ("17:00:00" local => "...T22:00:00.000Z").
const LIMA_UTC_OFFSET_HOURS = 5;

function buildFechaMovimiento(fecha) {
  const [datePart, timePart] = fecha.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = (timePart ?? '00:00').split(':').map(Number);
  return {
    fechaDeMovimiento: {
      date: new Date(Date.UTC(year, month - 1, day, hour + LIMA_UTC_OFFSET_HOURS, minute, 0, 0)).toISOString(),
      options: {
        timePicker: true,
        timePickerIncrement: 5,
        timePicker24Hour: true,
        linkedCalendars: false,
        autoUpdateInput: true,
        autoApply: true,
        locale: {
          format: 'DD/MM/YYYY HH:mm',
          separator: ' - ',
          applyLabel: 'Aplicar',
          cancelLabel: 'Cancelar',
          fromLabel: 'De',
          toLabel: 'A',
          customRangeLabel: 'Personalizado',
          daysOfWeek: ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa'],
          monthNames: ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'],
          firstDay: 1,
        },
        singleDatePicker: true,
        showDropdowns: true,
        minYear: 2015,
      },
    },
    requerimientomovimiento_fecha: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} ${pad(hour, 2)}:${pad(minute, 2)}:00`,
  };
}

async function guardarRequerimiento(page, session, body) {
  const {
    localOrigenId,
    almacenOrigenId,
    localDestinoId,
    encargado,
    receptor = '',
    observacion = '',
    fecha,
    esSolicitudCompra = false,
    items,
  } = body;

  if (!localOrigenId || !almacenOrigenId || !localDestinoId || !encargado || !fecha) {
    throw new Error('Faltan datos obligatorios para guardar el requerimiento.');
  }
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Agrega al menos un ítem al requerimiento.');
  }

  const [locales, almacenesOrigen] = await Promise.all([
    fetchRawLocals(page, session),
    fetchRawAlmacenes(page, session, localOrigenId),
  ]);

  const localSeleccionado = locales.find((local) => String(local.local_id) === String(localOrigenId));
  const localDestinoSeleccionado = locales.find((local) => String(local.local_id) === String(localDestinoId));
  const almacenSeleccionado = almacenesOrigen.find((almacen) => String(almacen.almacen_id) === String(almacenOrigenId));

  if (!localSeleccionado) throw new Error('Local de origen no encontrado.');
  if (!localDestinoSeleccionado) throw new Error('Local de destino no encontrado.');
  if (!almacenSeleccionado) throw new Error('Almacén de origen no encontrado.');

  const detalles = [];
  const productos = [];

  for (const entry of items) {
    const { item, cantidad } = entry;
    if (!item?.item_id || !cantidad || Number(cantidad) <= 0) {
      throw new Error('Cada ítem necesita una cantidad válida.');
    }

    const unidadId = item.unidadmedidainsumo_id ?? item.unidadmedidainsumo?.unidadmedidainsumo_id ?? 1;
    const costoStock = await apiGet(
      page,
      session.token,
      `/logistica/rest/common/obtenerCostoStockInsumoProducto/${item.item_id}/${unidadId}/${localOrigenId}`,
    ).catch(() => ({ data: {} }));

    detalles.push({
      ...item,
      almacen: almacenSeleccionado,
      costoStock: costoStock.data ?? {},
      item_cantidad: Number(cantidad),
      hasError: false,
      errorMessageList: [],
    });

    const esInsumo = String(item.item_tipo) === '1';
    productos.push({
      hasError: false,
      alamacendestino_descripcion: almacenSeleccionado.almacen_descripcion,
      detallerequerimiento_almacendestinoid: String(almacenOrigenId),
      insumo_id: esInsumo ? String(item.item_id) : null,
      producto_id: esInsumo ? null : String(item.item_id),
      producto_codigo: item.item_codigo ?? '',
      presentacioninsumo_id: item.item_presentacionid != null ? String(item.item_presentacionid) : null,
      detallerequerimiento_cantidad: Number(cantidad),
      unidadmedidainsumo: {
        unidadmedidainsumo_id: String(unidadId),
        unidadmedidainsumo_descripcion: item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? item.unidadmedidainsumo_descripcion ?? '',
      },
      producto_costo: 0,
      detallerequerimiento_costo: 0,
      detallerequerimiento_um: item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? item.unidadmedidainsumo_descripcion ?? '',
      producto_descripcion: item.item_descripcion ?? '',
    });
  }

  // El grid del ERP siempre viaja con 6 filas de detalle (ítems + relleno
  // vacío hasta completar la fila visible); se replica tal cual lo capturado.
  while (detalles.length < 6) detalles.push({});

  const { fechaDeMovimiento, requerimientomovimiento_fecha } = buildFechaMovimiento(fecha);

  const requerimiento = {
    esSoloPlantilla: '0',
    esSolicitudCompra: esSolicitudCompra ? '1' : '0',
    mostrarCostos: '0',
    mostrarPrecio: '0',
    mostrarRegistrar: true,
    fechaDeMovimiento,
    localSeleccionado,
    requerimientomovimiento_encargado: encargado,
    requerimientomovimiento_receptor: receptor,
    requerimientomovimiento_observacion: observacion,
    esplantilla: '0',
    detallerequerimientomovimiento: detalles,
    localDestinoList: locales,
    almacenDestinoList: [almacenSeleccionado],
    subtitulo: `a: ${localDestinoSeleccionado.local_descripcion}`,
    restringirBusquedaRecetas: false,
    almacenSeleccionado,
    localDestinoListaCompleta: locales,
    localDestinoSeleccionado,
    requerimientomovimiento_localproduccionid: String(localDestinoId),
    local_id: String(localOrigenId),
    requerimientomovimiento_fecha,
  };

  const result = await apiPost(page, session.token, '/logistica/rest/requerimientomovimiento/agregarSolicitudAbastecimiento', {
    requerimiento,
    productos,
  });

  return { ok: true, data: result.data ?? null };
}
