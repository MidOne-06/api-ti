const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
const today = new Date().toISOString().slice(0, 10);
let currentFilters = null;
let currentPage = 1;

$('#fechaInicio').value = today;
$('#fechaFin').value = today;
loadFilters();

['#fechaInicio', '#fechaFin'].forEach((selector) => $(selector).addEventListener('change', updateDateRange));
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => applyDatePreset(button.dataset.range)));
$('#rows').addEventListener('click', (event) => {
  const button = event.target.closest('[data-detail-id]');
  if (button) openDetail(button.dataset.detailId);
});
['#closeDetail', '#closeDetailFooter'].forEach((selector) => $(selector).addEventListener('click', () => $('#detailDialog').close()));
$('#pagePrevious').addEventListener('click', () => loadVentas(currentPage - 1));
$('#pageNext').addEventListener('click', () => loadVentas(currentPage + 1));
updateDateRange();

$('#filters-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!updateDateRange()) return;
  const locales = [...document.querySelectorAll('input[name="local"]:checked')].map((input) => input.value).join('-');
  currentFilters = {
    locales,
    moneda: $('#moneda').value,
    comprobante: $('#comprobante').value,
    estado: $('#estado').value,
    orden: $('#orden').value,
    registros: $('#registros').value,
    fechaInicio: $('#fechaInicio').value,
    fechaFin: $('#fechaFin').value,
  };
  loadVentas(1);
});

async function loadVentas(pagina) {
  if (!currentFilters) return;
  setStatus('Consultando Dim Sum con una sesión actualizada…');
  $('#pagePrevious').disabled = true;
  $('#pageNext').disabled = true;
  const params = new URLSearchParams({ ...currentFilters, pagina: String(pagina) });
  try {
    const response = await fetch(`/ventas/api/ventas?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    currentPage = data.pagina;
    render(data);
    setStatus('Consulta actualizada.');
  } catch (error) {
    setStatus(error.message || 'No fue posible cargar los datos.', true);
  }
}

async function loadFilters() {
  setStatus('Cargando locales disponibles…');
  try {
    const [localsResponse, monedasResponse, opcionesResponse] = await Promise.all([
      fetch('/ventas/api/locals'),
      fetch('/ventas/api/monedas'),
      fetch('/ventas/api/opciones'),
    ]);
    const [localsData, monedasData, opcionesData] = await Promise.all([localsResponse.json(), monedasResponse.json(), opcionesResponse.json()]);
    if (!localsResponse.ok) throw new Error(localsData.error);
    if (!monedasResponse.ok) throw new Error(monedasData.error);
    if (!opcionesResponse.ok) throw new Error(opcionesData.error);
    $('#locales').innerHTML = localsData.locals.map((local) => `<label class="local-option"><input type="checkbox" name="local" value="${escapeHtml(local.id)}" checked> ${escapeHtml(local.name)}</label>`).join('');
    setOptions('#moneda', monedasData.monedas.map((moneda) => ({ value: moneda.id, label: moneda.label })));
    setOptions('#comprobante', opcionesData.comprobantes);
    setOptions('#estado', opcionesData.estados);
    setOptions('#orden', opcionesData.orden);
    setStatus('Selecciona filtros y presiona "Aplicar filtros".');
  } catch (error) {
    setStatus(error.message || 'No se pudieron cargar los locales.', true);
  }
}

function setOptions(selector, options) { $(selector).innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join(''); }

function applyDatePreset(preset) {
  const base = new Date(`${today}T12:00:00`);
  let start = new Date(base);
  let end = new Date(base);
  if (preset === 'yesterday') start.setDate(start.getDate() - 1), end = new Date(start);
  if (preset === 'last7') start.setDate(start.getDate() - 6);
  if (preset === 'month') start = new Date(base.getFullYear(), base.getMonth(), 1);
  $('#fechaInicio').value = toDateInput(start);
  $('#fechaFin').value = toDateInput(end);
  document.querySelectorAll('[data-range]').forEach((button) => button.classList.toggle('active', button.dataset.range === preset));
  updateDateRange();
}

function updateDateRange() {
  const start = $('#fechaInicio').value;
  const end = $('#fechaFin').value;
  const summary = $('#dateSummary');
  document.querySelectorAll('[data-range]').forEach((button) => button.classList.remove('active'));
  if (!start || !end) {
    summary.textContent = 'Selecciona ambas fechas.';
    return false;
  }
  if (start > end) {
    summary.textContent = 'La fecha inicial no puede ser posterior a la fecha final.';
    summary.classList.add('date-error');
    return false;
  }
  summary.classList.remove('date-error');
  summary.textContent = `Consultarás desde ${formatDate(start)} hasta ${formatDate(end)}.`;
  return true;
}

function toDateInput(date) { return date.toISOString().slice(0, 10); }
function formatDate(value) { return new Intl.DateTimeFormat('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(`${value}T12:00:00`)); }
function formatDateTime(value) { return value ? new Intl.DateTimeFormat('es-PE', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value.replace(' ', 'T'))) : '—'; }

function render(data) {
  const registros = Number(currentFilters.registros) || 10;
  const start = data.total ? (data.pagina - 1) * registros + 1 : 0;
  const end = Math.min(data.pagina * registros, data.total);
  $('#summary').textContent = `${data.total} registro(s) encontrados · página ${data.pagina} de ${data.paginas}`;
  $('#pageInfo').textContent = `${start}-${end} de ${data.total} · página ${data.pagina} de ${data.paginas}`;
  $('#pagePrevious').disabled = data.pagina <= 1;
  $('#pageNext').disabled = data.pagina >= data.paginas;
  $('#rows').innerHTML = data.rows.length ? data.rows.map(rowTemplate).join('') : '<tr><td colspan="14" class="empty">No hay registros para los filtros seleccionados.</td></tr>';
}

function rowTemplate(row) {
  return `<tr>
    <td><button type="button" class="detail-link" data-detail-id="${escapeHtml(row.venta_id)}" title="Ver detalle de la venta ${escapeHtml(row.venta_id)}">${cell(row.venta_id)} · Ver</button></td>
    <td>${cell(row.venta_fecha)}</td>
    <td>${cell(row.local_descripcion)}</td>
    <td>${cell(row.localdestino_descripcion)}</td>
    <td>${cell(row.cliente_descripciion)}</td>
    <td>${cell(row.cliente_dniruc)}</td>
    <td>${cell(row.venta_tipodoc)} ${cell(row.venta_seriedoc)}-${cell(row.venta_numdoc)}</td>
    <td>${cell(row.moneda_descripcion)}</td>
    <td>${currency(row.venta_subtotal)}</td>
    <td>${currency(row.impuestos)}</td>
    <td>${currency(row.venta_total)}</td>
    <td>${cell(row.venta_formapago)}</td>
    <td>${cell(row.venta_estado)}</td>
    <td>${cell(row.usuario)}</td>
  </tr>`;
}

async function openDetail(id) {
  const dialog = $('#detailDialog');
  $('#detailTitle').textContent = `Detalle de venta #${id}`;
  $('#detailMeta').textContent = 'Cargando detalle desde Restaurant.pe…';
  $('#detailRows').innerHTML = '<tr><td colspan="5" class="empty">Cargando…</td></tr>';
  $('#detailPagos').innerHTML = '';
  dialog.showModal();
  try {
    const response = await fetch(`/ventas/api/ventas/${encodeURIComponent(id)}`);
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error);
    $('#detailTitle').textContent = `${detail.comprobante.tipo} ${detail.comprobante.serie}-${detail.comprobante.numero}`;
    $('#detailMeta').textContent = `Cliente: ${detail.cliente.nombre || '—'} (${detail.cliente.ruc || '—'}) · Local: ${detail.local || '—'} · Fecha: ${formatDateTime(detail.fecha)} · Forma de pago: ${detail.formaPago} · Vendedor: ${detail.usuario || '—'} · Total: ${currency(detail.total)}`;
    $('#detailRows').innerHTML = detail.items.length ? detail.items.map(detailRowTemplate).join('') : '<tr><td colspan="5" class="empty">Esta venta no tiene ítems.</td></tr>';
    $('#detailPagos').innerHTML = detail.pagos.length ? `<p class="muted">Pagos: ${detail.pagos.map((pago) => `${escapeHtml(pago.tipo)} ${currency(pago.monto)}`).join(' · ')}</p>` : '';
  } catch (error) {
    $('#detailMeta').textContent = error.message || 'No se pudo cargar el detalle.';
    $('#detailRows').innerHTML = '<tr><td colspan="5" class="empty">No disponible.</td></tr>';
  }
}

function detailRowTemplate(item) {
  return `<tr><td>${cell(item.descripcion)}</td><td>${number(item.cantidad).toFixed(3)}</td><td>${currency(item.precio)}</td><td>${currency(item.descuento)}</td><td>${currency(item.importe)}</td></tr>`;
}

function cell(value) { return escapeHtml(value ?? '—'); }
function currency(value) { return value == null || value === '' ? '—' : money.format(number(value)); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(message, isError = false) { $('#status').textContent = message; $('#status').style.color = isError ? '#bd3d3d' : ''; }
