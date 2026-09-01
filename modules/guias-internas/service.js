import { json, readJsonBody, serveStatic } from '../../lib/http.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_BASE, apiGet, apiPost, fetchBinary, fetchLocals, fetchLocalsDetail, sanitizeRemoteData, withSession } from '../../lib/restaurant-session.js';

export const prefix = '/guias-internas';
export const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'public');

export async function handleRequest(pathname, url, request, response) {
  if (!pathname.startsWith('/api/')) return serveStatic(publicDir, pathname, response);
  try {
    if (pathname === '/api/locals') return json(response, 200, { locals: await withSession((page, session) => localDetails(page, session)) });
    if (pathname === '/api/almacenes') {
      const localId = url.searchParams.get('local_id');
      if (!/^\d+$/.test(String(localId))) return json(response, 400, { error: 'Selecciona un local válido.' });
      return json(response, 200, { almacenes: await withSession((page, session) => warehouses(page, session, localId)) });
    }
    if (pathname === '/api/motivos') return json(response, 200, { motivos: motivos() });
    if (pathname === '/api/recurrentes') {
      const localId = url.searchParams.get('local_id');
      if (!/^\d+$/.test(String(localId))) return json(response, 400, { error: 'Selecciona un local válido.' });
      return json(response, 200, await withSession((page, session) => recurrentes(page, session, localId)));
    }
    if (pathname === '/api/siguiente-correlativo') {
      const serie = String(url.searchParams.get('serie') ?? '').trim();
      if (!serie) return json(response, 400, { error: 'Selecciona una serie válida.' });
      return json(response, 200, await withSession((page, session) => siguienteCorrelativo(page, session, serie)));
    }
    if (pathname === '/api/items') {
      const query = url.searchParams.get('q')?.trim() ?? ''; const localId = url.searchParams.get('local_id');
      if (!query || !/^\d+$/.test(String(localId))) return json(response, 200, { items: [] });
      return json(response, 200, { items: await withSession((page, session) => items(page, session, query, localId)) });
    }
    if (pathname === '/api/motorizados' && request.method === 'GET') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query) return json(response, 200, { motorizados: [] });
      return json(response, 200, { motorizados: await withSession((page, session) => motorizados(page, session, query)) });
    }
    if (pathname === '/api/transportistas' && request.method === 'GET') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query) return json(response, 200, { transportistas: [] });
      return json(response, 200, { transportistas: await withSession((page, session) => transportistas(page, session, query)) });
    }
    if (pathname === '/api/clientes' && request.method === 'GET') {
      const query = url.searchParams.get('q')?.trim() ?? '';
      if (!query) return json(response, 200, { clientes: [] });
      return json(response, 200, { clientes: await withSession((page, session) => clientes(page, session, query)) });
    }
    if (pathname === '/api/motorizados' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => createMotorizado(page, session, body)));
    }
    if (pathname === '/api/guardar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => create(page, session, body)));
    }
    if (pathname === '/api/requerimientos/importar' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => importRequirements(page, session, body)));
    }
    if (pathname === '/api/anular' && request.method === 'POST') {
      const body = await readJsonBody(request);
      return json(response, 200, await withSession((page, session) => cancel(page, session, body)));
    }
    if (pathname === '/api/reporte' && request.method === 'GET') {
      return withSession((page, session) => report(page, session, url, response));
    }
    if (pathname === '/api/guias') return json(response, 200, await withSession((page, session) => list(page, session, url)));
    const match = pathname.match(/^\/api\/guias\/(\d+)$/);
    if (match) return json(response, 200, await withSession((page, session) => detail(page, session, match[1])));
    return json(response, 404, { error: 'No encontrado.' });
  } catch (error) {
    console.error(error.message);
    return json(response, 502, { error: error.message || 'No se pudo consultar Guías internas.' });
  }
}

function motivos() { return [
  { id: '6', name: 'Traslado entre establecimientos de la misma empresa' },
  { id: '9', name: 'Traslado por emisor itinerante de comprobantes de pago' },
  { id: '13', name: 'Otros' },
]; }

async function localDetails(page, session) {
  const result = await fetchLocalsDetail(page, session);
  return result.locals.map((local) => ({
    id: String(local.local_id),
    name: local.descripcion ?? `Local ${local.local_id}`,
    direccion: local.direccion ?? '',
    ubigeo: local.ubigeo ?? '',
  }));
}

async function recurrentes(page, session, localId) {
  // Algunos locales permitidos no tienen valores recurrentes configurados;
  // Restaurant responde tipo 3 sin mensaje. La guía puede continuar con el
  // almacén/serie elegidos por el usuario, por lo que no debe bloquearse el
  // despacho nativo por esa conveniencia de la interfaz original.
  let defaults = { data: {} };
  try {
    defaults = await apiGet(page, session.token, `/logistica/rest/guiaremision/obtenerDatosRecurrentesByLocal/${localId}`);
  } catch (error) {
    if (!/tipo 3|sesión|sesion|rechazó la consulta/i.test(String(error.message))) throw error;
  }
  const series = await apiGet(page, session.token, `/logistica/rest/common/obtenerGuiaremisionSerieListByLocal/${localId}`);
  const row = defaults.data ?? {};
  return {
    serie: String(row.guiaremision_serie ?? ''),
    correlativo: String(row.guiaremision_correlativo ?? ''),
    almacenId: String(row.almacen_id ?? ''),
    series: (Array.isArray(series.data) ? series.data : []).map((item) => String(item.comprobante_serie ?? '')).filter(Boolean),
  };
}

async function siguienteCorrelativo(page, session, serie) {
  const result = await apiGet(page, session.token, `/logistica/rest/guiaremision/obtenerSiguienteCorrelativoPorSerie/${encodeURIComponent(serie)}`);
  const row = result.data ?? {};
  return { serie: String(row.guiaremision_serie ?? serie), correlativo: String(row.guiaremision_correlativo ?? '') };
}

async function items(page, session, query, localId) {
  const result = await apiPost(page, session.token, '/logistica/rest/common/busqueda/busquedaSensitivaSegunTipos', { busqueda: query, esInsumo: 1, esReceta: 1, esPorcionable: 1, esDescartable: 1, esModificador: 0, esCombo: 1, esProdTrans: 1, esProdNoTrans: 1, busqPorCodigo: 0, agruparInsumo: 1, esDerivado: 1, obtenerSoloPreentacionesDeVenta: 0, esProdContStock: 0, agruparProducto: 0, esConsumible: 1, local_id: String(localId), proveedor_id: -1, esActivo: 1, paraArqueo: -1 });
  return (Array.isArray(result.data) ? result.data : []).slice(0, 30).map((item) => ({ ...sanitizeRemoteData(item), id: String(item.item_id ?? ''), codigo: item.item_codigo ?? '', descripcion: item.item_descripcion ?? '', presentacionId: String(item.presentacion_id ?? item.presentacioninsumo_id ?? item.item_presentacionid ?? ''), presentacion: item.presentacion_nombre ?? item.item_presentacion ?? '', unidad: item.unidadmedidainsumo ?? { unidadmedidainsumo_id: String(item.unidadmedidainsumo_id ?? 1), unidadmedidainsumo_descripcion: item.unidadmedida_descripcion ?? '' } }));
}

async function motorizados(page, session, query) {
  const result = await apiGet(page, session.token, `/api/rest/motorizado/obtenerTodoslosMotorizadosPorBusquedaPaginadoParaDelivery/${encodeURIComponent(query)}/-1/1/10/null`);
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({
    id: String(row.motorizado_id ?? ''),
    nombre: [row.motorizado_nombres, row.motorizado_apellidos].filter(Boolean).join(' ').trim(),
    placa: row.movilidad_placa ?? '', licencia: row.motorizado_licencia ?? '', mtc: row.motorizado_mtc ?? '',
  })).filter((row) => row.id && row.nombre);
}

async function transportistas(page, session, query) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/transportista/obtenerTodoslosTransportistasPorBusquedaPaginado/${encodeURIComponent(query)}/-1/1/10`);
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({
    id: String(row.transportista_id ?? ''), nombre: String(row.transportista_razonsocial ?? ''), ruc: String(row.transportista_ruc ?? ''), mtc: row.transportista_mtc ?? '', placa: row.transportista_placa ?? '',
  })).filter((row) => row.id && row.nombre);
}

async function clientes(page, session, query) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/cliente/obtenerClienteBusquedaPaginado/${encodeURIComponent(query)}/-1/-1/1/10`);
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({
    id: String(row.cliente_id ?? ''), nombre: String(row.nombreapellido ?? row.cliente_nombres ?? '').trim(), documento: String(row.cliente_dniruc ?? ''),
  })).filter((row) => row.id && row.nombre);
}

async function createMotorizado(page, session, body) {
  const nombres = String(body.nombres ?? '').trim(), apellidos = String(body.apellidos ?? '').trim(), dni = String(body.dni ?? '').trim();
  if (nombres.length < 3 || apellidos.length < 3 || !/^\d{8}$/.test(dni)) throw new Error('Completa nombres, apellidos y un DNI válido de 8 dígitos.');
  const motorizado = {
    motorizado_id: '-1', motorizado_nombres: nombres, motorizado_apellidos: apellidos, motorizado_dni: dni,
    motorizado_licencia: String(body.licencia ?? '').trim(), motorizado_direccion: String(body.direccion ?? '').trim(),
    motorizado_mtc: String(body.mtc ?? '').trim(), motorizado_telefono: String(body.telefono ?? '').trim(), motorizado_estado: '1',
  };
  if (!motorizado.motorizado_direccion) throw new Error('La dirección del motorizado es obligatoria.');
  const result = await apiPost(page, session.token, '/api/rest/motorizado/motorizado', motorizado);
  return { ok: true, id: String(result.data ?? ''), motorizado: { id: String(result.data ?? ''), nombre: `${nombres} ${apellidos}`, licencia: motorizado.motorizado_licencia, mtc: motorizado.motorizado_mtc, placa: '' }, mensajes: result.mensajes ?? [] };
}

async function create(page, session, body) {
  const localId = String(body.originLocalId ?? body.localId ?? ''), destinoId = String(body.destinationLocalId ?? body.destinoId ?? ''), almacenId = String(body.warehouseId ?? ''), motivoId = String(body.motivoId ?? ''), fechaEmision = asDateTime(body.emissionDate ?? body.date ?? body.fecha ?? ''), fechaTraslado = asDateTime(body.transferDate ?? body.date ?? body.fecha ?? '');
  const entries = Array.isArray(body.items) ? body.items : [];
  if (!/^\d+$/.test(localId) || !/^\d+$/.test(destinoId) || localId === destinoId || !/^\d+$/.test(almacenId) || !['6','9','13'].includes(motivoId) || !fechaEmision || !fechaTraslado || entries.length === 0) throw new Error('Completa origen, destino, almacén, motivo, fechas y al menos un ítem.');
  const locals = await localDetails(page, session); const local = locals.find((x) => String(x.id) === localId), destino = locals.find((x) => String(x.id) === destinoId); if (!local || !destino) throw new Error('El origen o destino ya no está disponible en Restaurant.');
  // No sombrear la función `warehouses()`: la declaración local entraba en
  // temporal dead zone al resolver la llamada y bloqueaba el registro antes
  // de que Restaurant recibiera la guía.
  const availableWarehouses = await warehouses(page, session, localId); const warehouse = availableWarehouses.find((x) => String(x.id) === almacenId); if (!warehouse) throw new Error('El almacén ya no está disponible en Restaurant.');
  // Restaurant clasifica `item_tipo = 1` como insumo. Un detalle real de
  // guía (guía #5389) confirma que debe viajar en insumo_id junto a
  // presentacioninsumo_id; la asignación inversa resolvía IDs ajenos como
  // productos y provocaba rechazos del ERP.
  const productos = entries.map((entry) => { const item = entry.item ?? {}; const quantity = Number(entry.quantity ?? 0); if (!item.item_id || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Cada ítem requiere una cantidad mayor a cero.'); const price = Number(item.item_precio ?? item.producto_costo ?? item.item_costo ?? 0), type = String(item.item_tipo ?? '1'), presentationId = String(item.presentacion_id ?? item.presentacioninsumo_id ?? item.item_presentacionid ?? ''); return { almacenSeleccionado: { almacen_id: almacenId, almacen_descripcion: warehouse.name }, almacen_id: almacenId, descripcioncategoria: item.item_categoria ?? '', detalleguia_unidadmedida: item.unidadmedidainsumo ?? item.unidad, detalleguiaremision_cantidad: quantity, detalleguiaremision_costo: Number(item.producto_costo ?? price), detalleguiaremision_descuento: 0, detalleguiaremision_estado: 1, detalleguiaremision_precio: price, detalleguiaremision_precioreal: price, detalleguiaremision_productodescripcion: item.item_descripcion ?? item.descripcion ?? '', detalleguiaremision_total: price * quantity, detalleguiaremision_peso: 0, guiaremision_id: '-1', ...(type === '1' ? { insumo_id: String(item.item_id), presentacioninsumo_id: presentationId } : { detalleguiaremision_productoid: String(item.item_id), presentacioncompraproducto_id: presentationId }), porcentaje: 0 }; });
  const direccionId = String(body.destinationAddressLocalId ?? '0');
  const direccionLocal = direccionId !== '0' ? locals.find((item) => String(item.id) === direccionId) : null;
  if (direccionLocal && String(direccionLocal.id) !== destinoId) throw new Error('La dirección elegida no corresponde al local de destino.');
  const transporteInterno = body.internalTransport ? '1' : '0';
  const requirementIds = Array.isArray(body.requerimientoIds)
    ? body.requerimientoIds.map((id) => String(id)).filter((id) => /^\d+$/.test(id))
    : [];
  const guiaremision = { guiaremision_id: '-1', local_id: localId, guiaremision_localorigenid: localId, guiaremision_localdestinoid: destinoId, guiaremision_fechaemision: fechaEmision, guiaremision_fechatraslado: fechaTraslado, guiaremision_motivotraslado: motivoId, guiaremision_estado: '1', guiaremision_eselectronica: '0', guiaremision_transporteinterno: transporteInterno, guiaremision_serie: String(body.serie ?? '').trim(), guiaremision_correlativo: String(body.correlativo ?? '').trim(), guiaremision_total: productos.reduce((sum, x) => sum + x.detalleguiaremision_total, 0), almacenSeleccionado: { almacen_id: almacenId, almacen_descripcion: warehouse.name }, localSeleccionado: local, localdestinoidSeleccionado: destino, guiaremision_destinonombre: direccionLocal?.direccion || 'Sin dirección de destino', guiaremision_destinoubigeo: direccionLocal?.ubigeo || null, guiaremision_observacion: String(body.observacion ?? '').trim(), mostrarCosto: body.showCosts ? '1' : '0', cliente_id: body.clientId ? String(body.clientId) : null, guiaremision_transportistaplaca: String(body.placa ?? '').trim() };
  // Este campo es el vínculo nativo que usa Restaurant al abrir
  // logistica.guiaremision.canjerequerimientos. No se infiere desde texto ni
  // se sustituye por una referencia local.
  if (requirementIds.length > 0) guiaremision.listaRequerimientosImportados = requirementIds;
  if (transporteInterno === '1' && body.motorcyclistId) { guiaremision.motorizado_id = String(body.motorcyclistId); guiaremision.guiaremision_transportistalicencia = String(body.licencia ?? '').trim(); guiaremision.guiaremision_transportistamtc = String(body.mtc ?? '').trim(); }
  if (transporteInterno === '0' && body.carrierId) { guiaremision.transportista_id = String(body.carrierId); guiaremision.guiaremision_transportistamtc = String(body.mtc ?? '').trim(); }
  const result = await apiPost(page, session.token, '/logistica/rest/guiaremision/addGuiaremision', { guiaremision, productos });
  return { ok: true, id: String(result.data?.guiaremision_id ?? result.data ?? ''), mensajes: result.mensajes ?? [] };
}

async function importRequirements(page, session, body) {
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => String(id)).filter((id) => /^\d+$/.test(id)) : [];
  if (ids.length === 0) throw new Error('Selecciona al menos un requerimiento válido.');
  const result = await apiPost(page, session.token, '/logistica/rest/guiaremision/obtenerRequerimientoStockAImportar', ids);
  const data = result.data ?? {};
  return {
    ok: true,
    guiaremision: sanitizeRemoteData(data.guiaremision ?? {}),
    productos: sanitizeRemoteData(Array.isArray(data.productos) ? data.productos : []),
    localQueSolicito: sanitizeRemoteData(data.localQueSolicito ?? null),
    mensajes: result.mensajes ?? [],
  };
}

async function cancel(page, session, body) {
  const id = String(body.id ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error('La guía interna no es válida.');
  const devolver = body.devolverCantidades === false ? '0' : '1';
  const result = await apiGet(page, session.token, `/logistica/rest/guiaremision/anulaGuiaremision/${id}/${devolver}`);
  return { ok: true, mensajes: result.mensajes ?? [], data: sanitizeRemoteData(result.data ?? {}) };
}

async function report(page, session, url, response) {
  const id = String(url.searchParams.get('id') ?? '').trim();
  const variant = String(url.searchParams.get('variant') ?? 'guia').trim();
  if (!/^\d+$/.test(id)) throw new Error('La guía interna no es válida.');

  const variants = {
    trabajo: { page: 'hojatrabajo_logistica_guiaremision', type: 'pdf', name: `HojaDeTrabajoGuiaInterna${id}` },
    guia: { page: 'guiaremision_logistica_guiaremision', type: 'pdf', name: `GuiaInterna${id}` },
    guia_v2: { page: 'guiaremision_logistica_guiaremision', type: 'pdf', name: `GuiaInterna${id}`, mostrarCabeceraFE: '1' },
    guia_sin_precio: { page: 'guiaremision_logistica_guiaremision', type: 'pdf', name: `GuiaInterna${id}`, mostrarPrecio: '0' },
    guia_v2_sin_precio: { page: 'guiaremision_logistica_guiaremision', type: 'pdf', name: `GuiaInterna${id}`, mostrarPrecio: '0', mostrarCabeceraFE: '1' },
    matricial: { page: 'guiaremision_logistica_guiaremisionmatricial01pdf', type: 'pdf', name: `GuiaInterna${id}` },
    imprimir_matricial: { page: 'guiaremision_logistica_guiaremisionmatricial01pdf', type: 'pdf', name: `GuiaInterna${id}` },
    csv: { page: 'guiaremision_logistica_guiaremisionexcel', type: 'csv', name: `HojaDeGuiaInterna${id}`, or: 'L' },
  };
  const config = variants[variant];
  if (!config) throw new Error('El formato solicitado no está disponible.');

  const params = new URLSearchParams({
    page: config.page, or: config.or ?? 'P', type: config.type, margen: '10', footer: '1',
    guiaremision_id: id, name: config.name, token: session.token,
  });
  if (config.mostrarPrecio) params.set('mostrarPrecio', config.mostrarPrecio);
  if (config.mostrarCabeceraFE) params.set('mostrarCabeceraFE', config.mostrarCabeceraFE);
  const { buffer, contentType } = await fetchBinary(page, `${API_BASE}/api/reports/report.php?${params.toString()}`);
  const extension = config.type === 'csv' ? 'csv' : 'pdf';
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename="${config.name}.${extension}"`,
    'Content-Length': buffer.length,
  });
  response.end(buffer);
}

function asDateTime(value) {
  const raw = String(value ?? '').trim().replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?)?$/.test(raw)) return null;
  return raw.length === 10 ? `${raw} ${new Date().toLocaleTimeString('en-GB', { hour12: false, timeZone: 'America/Lima' })}` : raw.length === 16 ? `${raw}:00` : raw;
}

async function warehouses(page, session, localId) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/almacen/getAll/${localId}/1/0/0`);
  return (Array.isArray(result.data) ? result.data : []).map((row) => ({ id: String(row.almacen_id), name: row.almacen_descripcion ?? '' })).filter((row) => row.id && row.name);
}

function date(value, end = false) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value} ${end ? '23:59:59' : '00:00:00'}` : null;
}

async function list(page, session, url) {
  const locals = await fetchLocals(page, session);
  const allowed = new Set(locals.map((item) => String(item.id)));
  const requested = (url.searchParams.get('locales') ?? '').split(',').filter((id) => allowed.has(id));
  const selected = requested.length ? requested : [...allowed];
  const today = new Date().toISOString().slice(0, 10);
  const payload = {
    pagina: Math.max(1, Number(url.searchParams.get('pagina') ?? 1)), tipolista: '2', locales: selected.join('-'),
    estado: Number(url.searchParams.get('estado') ?? 1), motivo: Number(url.searchParams.get('motivo') ?? -1), buscarSegun: Number(url.searchParams.get('buscar_segun') ?? 1),
    local_id: String(session.localId ?? selected[0] ?? ''), fecha_inicio: date(url.searchParams.get('fecha_inicio') ?? today) ?? `${today} 00:00:00`,
    fecha_fin: date(url.searchParams.get('fecha_fin') ?? today, true) ?? `${today} 23:59:59`, registros: Math.min(100, Math.max(10, Number(url.searchParams.get('registros') ?? 50))),
    serie: url.searchParams.get('serie') ?? '', numero: url.searchParams.get('numero') ?? '', searchCodUnico: url.searchParams.get('codigo') ?? '',
    almacen: Number(url.searchParams.get('almacen') ?? -1), itemIdList: '', itemTipoList: '', filtroPorFecha: 1, cliente_id: -1,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  const [result, header] = await Promise.all([
    apiGet(page, session.token, `/logistica/rest/guiaremision/obtenerGuiaremisionLista/${encoded}?readonly=true&sobreEscribirRedis=0`),
    apiGet(page, session.token, `/logistica/rest/guiaremision/obtenerCabeceraListaDeGuiasremision/${encoded}`),
  ]);
  const rows = Array.isArray(result.data) ? result.data : [];
  return { filters: payload, header: sanitizeRemoteData(header.data ?? {}), total: Number(result.totalregistros ?? rows.length), rows: rows.map(mapRow) };
}

async function detail(page, session, id) {
  const result = await apiGet(page, session.token, `/logistica/rest/common/guiaremision/obtenerGuiaremision/${id}`);
  const source = result.data ?? {};
  const guide = source.guiaremision ?? source;
  const details = Array.isArray(source.detalleguiaremision) ? source.detalleguiaremision : (Array.isArray(source.detalleGuiaremision) ? source.detalleGuiaremision : []);
  // Restaurant expone el vínculo de una guía generada desde requerimiento dentro
  // de requerimientomovimientoList; no siempre lo repite en la cabecera.
  const linkedRequirement = guide.guiaremision_requerimientomovimientoid
    ?? guide.requerimientomovimiento_id
    ?? guide.requerimientomovimientoList?.[0]?.requerimientomovimiento_id
    ?? source.requerimientomovimientoList?.[0]?.requerimientomovimiento_id
    ?? '';
  return {
    sourceData: sanitizeRemoteData(source),
    ...mapRow(guide),
    observacion: guide.guiaremision_observacion ?? guide.guiaremision_razon ?? '',
    direccionDestino: guide.guiaremision_destinonombre ?? guide.guiaremision_direccioncliente ?? '',
    direccionDestinoPayload: {
      id: guide.direccioncliente_id ?? null, via: guide.guiaremision_destinovia ?? null,
      numero: guide.guiaremision_destinonumero ?? null, interior: guide.guiaremision_destinointerior ?? null,
      zona: guide.guiaremision_destinozona ?? null, distrito: guide.guiaremision_destinodistrito ?? null,
      provincia: guide.guiaremision_destinoprovincia ?? null, departamento: guide.guiaremision_destinodepartamento ?? null,
      ubigeo: guide.guiaremision_destinoubigeo ?? null,
    },
    requerimientoId: String(linkedRequirement), movimientoId: String(guide.movimiento_id ?? ''),
    items: details.map((item) => ({
      id: String(item.detalleguiaremision_id ?? item.id ?? ''), itemId: String(item.item_id ?? ''), itemTipo: String(item.item_tipo ?? ''),
      codigo: item.item_codigo ?? '', item: item.item_descripcion ?? item.descripcionProductoInsumo ?? '', categoria: item.item_categoria ?? item.categoria_descripcion ?? '',
      presentacion: item.presentacion_nombre ?? item.item_presentacion ?? '', unidad: item.unidadmedida_descripcion ?? item.unidadmedidainsumo?.unidadmedidainsumo_descripcion ?? '',
      almacenId: String(item.almacen_id ?? item.almacen?.almacen_id ?? ''), almacen: item.almacen?.almacen_descripcion ?? item.almacen_descripcion ?? '',
      cantidad: Number(item.item_cantidad ?? item.detalleguiaremision_cantidad ?? 0), cantidadSalida: Number(item.detalleguiaremision_cantidad ?? item.item_cantidad ?? 0),
      stock: item.item_stock ?? item.stock ?? '', peso: Number(item.item_peso ?? item.detalleguiaremision_peso ?? 0), precio: Number(item.item_precio ?? item.detalleguiaremision_precio ?? 0),
      descuento: Number(item.item_descuento ?? 0), total: Number(item.item_total ?? item.detalleguiaremision_total ?? 0),
      pendienteDescargaStock: String(item.detalleguiaremision_pendientedescargastock ?? ''), payloadRestaurant: sanitizeRemoteData(item),
    })),
  };
}

function mapRow(row) {
  return {
    id: String(row.guiaremision_id ?? ''), correlativo: row.guiaremision_correlativo ?? '', serie: row.guiaremision_serie ?? '',
    fechaRegistro: row.guiaremision_fecharegistro ?? '', fechaEmision: row.guiaremision_fechaemision ?? '', fechaTraslado: row.guiaremision_fechatraslado ?? '',
    localOrigenId: String(row.guiaremision_localorigenid ?? row.localorigen_id ?? ''), localOrigen: row.localorigen_descripcion ?? row.localorigen?.local_descripcion ?? '',
    localDestinoId: String(row.guiaremision_localdestinoid ?? row.localdestino_id ?? ''), localDestino: row.localdestino_descripcion ?? row.localdestino?.local_descripcion ?? '',
    almacenId: String(row.almacen_id ?? row.almacen?.almacen_id ?? ''), almacen: row.almacen?.almacen_descripcion ?? row.almacen_descripcion ?? '',
    motivoId: String(row.guiaremision_motivotraslado ?? ''), motivo: row.motivotraslado_descripcion ?? row.motivo_descripcion ?? '',
    estadoCodigo: String(row.guiaremision_estado ?? row.estado ?? ''), estado: row.estado ?? '', recepcionada: row.recepcionada ?? '',
    total: Number(row.guiaremision_total ?? 0), totalItems: Number(row.guiaremision_total_items ?? 0), pendienteProcesarStock: String(row.guiaremision_pendienteprocesarstock ?? ''),
    payloadRestaurant: sanitizeRemoteData(row),
  };
}
