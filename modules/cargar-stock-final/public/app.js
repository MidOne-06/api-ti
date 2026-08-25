const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
let items = [];
let almacenesCache = [];

$('#fecha').value = toDateTimeLocal(new Date());
loadLocals();

$('#local').addEventListener('change', onLocalChange);
$('#filters-form').addEventListener('submit', onSubmitFilters);
$('#guardarBtn').addEventListener('click', openConfirmDialog);
$('#cancelConfirm').addEventListener('click', () => $('#confirmDialog').close());
$('#acceptConfirm').addEventListener('click', guardarCuadre);
$('#busqueda').addEventListener('input', renderTable);

async function loadLocals() {
  setStatus('Cargando locales disponibles…');
  try {
    const [localsRes, tiposRes, categoriasRes] = await Promise.all([
      fetch('/cargar-stock-final/api/locals'),
      fetch('/cargar-stock-final/api/tipos'),
      fetch('/cargar-stock-final/api/categorias'),
    ]);
    const [localsData, tiposData, categoriasData] = await Promise.all([localsRes.json(), tiposRes.json(), categoriasRes.json()]);
    if (!localsRes.ok) throw new Error(localsData.error);
    if (!tiposRes.ok) throw new Error(tiposData.error);
    if (!categoriasRes.ok) throw new Error(categoriasData.error);
    setOptions('#local', localsData.locals.map((local) => ({ value: local.id, label: local.name })));
    setOptions('#tipo', tiposData.tipos.map((tipo) => ({ value: tipo.value, label: tipo.label })));
    setOptions('#categoria', categoriasData.categorias.map((categoria) => ({ value: categoria.id, label: categoria.label })));
    setStatus('Selecciona un local para ver sus almacenes.');
    if (localsData.locals.length) onLocalChange();
  } catch (error) {
    setStatus(error.message || 'No se pudieron cargar los locales.', true);
  }
}

async function onLocalChange() {
  const localId = $('#local').value;
  if (!localId) return;
  setStatus('Cargando almacenes del local…');
  try {
    const response = await fetch(`/cargar-stock-final/api/almacenes?local_id=${encodeURIComponent(localId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    almacenesCache = data.almacenes;
    setOptions('#almacen', almacenesCache.map((almacen) => ({ value: almacen.id, label: almacen.nombre })));
    setStatus('Selecciona filtros y presiona "Cargar ítems".');
  } catch (error) {
    setStatus(error.message || 'No se pudieron cargar los almacenes.', true);
  }
}

async function onSubmitFilters(event) {
  event.preventDefault();
  const localId = $('#local').value;
  const almacenId = $('#almacen').value;
  if (!localId || !almacenId) return setStatus('Selecciona local y almacén.', true);
  const params = new URLSearchParams({
    local_id: localId,
    almacen_id: almacenId,
    categoria_id: $('#categoria').value,
    tipo: $('#tipo').value,
    busqueda: $('#busqueda').value.trim(),
    fecha: fromDateTimeLocal($('#fecha').value),
    registros: $('#registros').value,
  });
  setStatus('Cargando ítems del almacén…');
  clearResultBanner();
  try {
    const response = await fetch(`/cargar-stock-final/api/items?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    items = data.items;
    renderTable();
    setStatus(`${items.length} ítem(s) cargados.`);
  } catch (error) {
    setStatus(error.message || 'No se pudieron cargar los ítems.', true);
    items = [];
    renderTable();
  }
}

function renderTable() {
  const rows = $('#rows');
  const query = $('#busqueda').value.trim().toLowerCase();
  const visible = query
    ? items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => `${item.item_descripcion ?? ''} ${item.item_codigo ?? ''}`.toLowerCase().includes(query))
    : items.map((item, index) => ({ item, index }));
  if (!items.length) {
    rows.innerHTML = '<tr><td colspan="9" class="empty">Sin ítems para los filtros seleccionados.</td></tr>';
  } else if (!visible.length) {
    rows.innerHTML = '<tr><td colspan="9" class="empty">Ningún ítem coincide con la búsqueda.</td></tr>';
  } else {
    rows.innerHTML = visible.map(({ item, index }) => rowTemplate(item, index)).join('');
    rows.querySelectorAll('.stock-input').forEach((input) => input.addEventListener('input', onCellEdit));
  }
  updateChangedSummary();
}

function rowTemplate(item, index) {
  const almacen = item.almacenes?.[0] ?? {};
  const changed = isChanged(almacen);
  return `<tr class="${changed ? 'changed-row' : ''}" data-index="${index}">
    <td>${cell(item.item_codigo)}</td>
    <td>${cell(item.item_descripcion)}${changed ? '<span class="changed-badge">editado</span>' : ''}</td>
    <td>${cell(item.categoria_descripcion)}</td>
    <td>${number(almacen.cantidad2).toFixed(3)}</td>
    <td><input class="stock-input" type="number" step="any" data-field="inventario_cantidad" data-index="${index}" value="${number(almacen.inventario_cantidad).toFixed(3)}"></td>
    <td>${number(almacen.costo).toFixed(4)}</td>
    <td><input class="stock-input" type="number" step="any" data-field="costoNuevo" data-index="${index}" value="${number(almacen.costoNuevo).toFixed(4)}"></td>
    <td class="${variacion(almacen) > 0 ? 'increase' : variacion(almacen) < 0 ? 'decrease' : ''}">${variacion(almacen).toFixed(3)}</td>
    <td class="stock-value">${money.format(variacion(almacen) * number(almacen.costoNuevo))}</td>
  </tr>`;
}

function onCellEdit(event) {
  const index = Number(event.target.dataset.index);
  const field = event.target.dataset.field;
  const almacen = items[index]?.almacenes?.[0];
  if (!almacen) return;
  almacen[field] = event.target.value === '' ? 0 : Number(event.target.value);
  renderTable();
}

function isChanged(almacen) {
  return number(almacen.inventario_cantidad) !== number(almacen.cantidad2) || number(almacen.costoNuevo) !== number(almacen.costo);
}

function variacion(almacen) {
  return number(almacen.inventario_cantidad) - number(almacen.cantidad2);
}

function updateChangedSummary() {
  const cambiados = items.filter((item) => isChanged(item.almacenes?.[0] ?? {}));
  $('#changedSummary').textContent = `${cambiados.length} de ${items.length} ítems con cambios.`;
  $('#summary').textContent = `${items.length} ítem(s) cargados.`;
  $('#guardarBtn').disabled = cambiados.length === 0;
}

function openConfirmDialog() {
  const cambiados = items.filter((item) => isChanged(item.almacenes?.[0] ?? {}));
  if (!cambiados.length) return;
  $('#confirmLocal').textContent = $('#local').selectedOptions[0]?.textContent ?? '—';
  $('#confirmAlmacen').textContent = $('#almacen').selectedOptions[0]?.textContent ?? '—';
  $('#confirmFecha').textContent = $('#fecha').value ? formatDateTime(fromDateTimeLocal($('#fecha').value)) : '—';
  $('#confirmRazon').textContent = $('#razon').value.trim() || '—';
  $('#confirmCantidad').textContent = `${cambiados.length} ítem(s)`;
  $('#confirmDialog').showModal();
}

async function guardarCuadre() {
  $('#confirmDialog').close();
  const body = {
    local_id: $('#local').value,
    fecha: fromDateTimeLocal($('#fecha').value),
    razon: $('#razon').value.trim(),
    items,
  };
  setStatus('Guardando cuadre en Restaurant.pe…');
  $('#guardarBtn').disabled = true;
  try {
    const response = await fetch('/cargar-stock-final/api/guardar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    showResultBanner(`Cuadre guardado correctamente. Ítems guardados: ${data.itemsGuardados}.`, false);
    setStatus('Cuadre guardado.');
    items = [];
    renderTable();
  } catch (error) {
    showResultBanner(error.message || 'No se pudo guardar el cuadre.', true);
    setStatus('No se pudo guardar el cuadre.', true);
    updateChangedSummary();
  }
}

function showResultBanner(message, isError) {
  $('#resultBanner').innerHTML = `<div class="banner ${isError ? 'banner-error' : 'banner-success'}">${escapeHtml(message)}</div>`;
}

function clearResultBanner() { $('#resultBanner').innerHTML = ''; }

function setOptions(selector, options) { $(selector).innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join(''); }
function cell(value) { return escapeHtml(value ?? '—'); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(message, isError = false) { $('#status').textContent = message; $('#status').style.color = isError ? '#bd3d3d' : ''; }
function toDateTimeLocal(date) { const pad = (n) => String(n).padStart(2, '0'); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`; }
function fromDateTimeLocal(value) { return value ? `${value.replace('T', ' ')}:00` : ''; }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value.replace(' ', 'T'))) : '—'; }
