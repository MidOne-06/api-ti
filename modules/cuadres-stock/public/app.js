const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN' });
const today = new Date().toISOString().slice(0, 10);
const selectedItems = [];
let searchTimer;
let reportRows = [];
let activeReport = 'master';
const reportPages = { master: 1, summary: 1 };

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
document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => showReport(button.dataset.report)));
['#reportLocal', '#reportWarehouse', '#reportItem', '#reportType'].forEach((selector) => $(selector).addEventListener('change', renderConsolidatedReports));
$('#clearReportFilters').addEventListener('click', clearReportFilters);
$('#reportPageSize').addEventListener('change', () => { reportPages.master = 1; reportPages.summary = 1; renderConsolidatedReports(); });
$('#reportPrevious').addEventListener('click', () => changeReportPage(-1));
$('#reportNext').addEventListener('click', () => changeReportPage(1));
updateDateRange();

$('#itemSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const query = $('#itemSearch').value.trim();
  if (!query) return hideSuggestions();
  searchTimer = setTimeout(() => searchItems(query), 350);
});

$('#itemSearch').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideSuggestions();
});

$('#filters-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!updateDateRange()) return;
  const locales = [...document.querySelectorAll('input[name="local"]:checked')].map((input) => input.value).join('-');
  const params = new URLSearchParams({
    locales,
    estado: $('#estado').value,
    tipo: $('#tipo').value,
    fechaInicio: $('#fechaInicio').value,
    fechaFin: $('#fechaFin').value,
    pagina: '1',
    itemIdList: selectedItems.map((item) => item.id).join('-'),
    itemTipoList: selectedItems.map((item) => item.type).join('-'),
  });
  setStatus('Consultando Dim Sum con una sesión actualizada…');
  try {
    const response = await fetch(`/cuadres-stock/api/cuadres?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    render(data);
    loadStockReports(params);
    setStatus('Consulta actualizada.');
  } catch (error) {
    setStatus(error.message || 'No fue posible cargar los datos.', true);
  }
});

async function loadFilters() {
  setStatus('Cargando locales disponibles…');
  try {
    const [localsResponse, optionsResponse] = await Promise.all([fetch('/cuadres-stock/api/locals'), fetch('/cuadres-stock/api/filter-options')]);
    const [localsData, optionsData] = await Promise.all([localsResponse.json(), optionsResponse.json()]);
    if (!localsResponse.ok) throw new Error(localsData.error);
    if (!optionsResponse.ok) throw new Error(optionsData.error);
    $('#locales').innerHTML = localsData.locals.map((local) => `<label class="local-option"><input type="checkbox" name="local" value="${escapeHtml(local.id)}" checked> ${escapeHtml(local.name)}</label>`).join('');
    setOptions('#estado', optionsData.estados);
    setOptions('#tipo', optionsData.tipos);
    setStatus('Selecciona filtros y presiona “Aplicar filtros”.');
  } catch (error) {
    setStatus(error.message || 'No se pudieron cargar los locales.', true);
  }
}

async function loadStockReports(params) {
  const section = $('#stockReports');
  section.hidden = false;
  $('#reportSummary').textContent = 'Consolidando stock de los cuadres filtrados…';
  $('#masterReportRows').innerHTML = '<tr><td colspan="6" class="empty">Generando reporte…</td></tr>';
  $('#summaryReportRows').innerHTML = '<tr><td colspan="4" class="empty">Generando reporte…</td></tr>';
  try {
    const response = await fetch(`/cuadres-stock/api/stock-report?${params}`);
    const report = await response.json();
    if (!response.ok) throw new Error(report.error);
    reportRows = report.master || [];
    populateReportFilters(reportRows);
    renderConsolidatedReports();
    showReport('master');
  } catch (error) {
    $('#reportSummary').textContent = error.message || 'No se pudo generar el reporte consolidado.';
    $('#masterReportRows').innerHTML = '<tr><td colspan="6" class="empty">No disponible.</td></tr>';
    $('#summaryReportRows').innerHTML = '<tr><td colspan="4" class="empty">No disponible.</td></tr>';
  }
}

function populateReportFilters(rows) {
  const filters = [
    ['#reportLocal', 'local', 'Todos los locales'],
    ['#reportWarehouse', 'almacen', 'Todos los almacenes'],
    ['#reportItem', 'item', 'Todos los ítems'],
    ['#reportType', 'tipo', 'Todos los tipos'],
  ];
  filters.forEach(([selector, field, placeholder]) => {
    const values = [...new Set(rows.map((row) => row[field]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'es'));
    $(selector).innerHTML = `<option value="">${placeholder}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}`;
  });
}

function clearReportFilters() {
  ['#reportLocal', '#reportWarehouse', '#reportItem', '#reportType'].forEach((selector) => { $(selector).value = ''; });
  renderConsolidatedReports();
}

function renderConsolidatedReports() {
  reportPages.master = 1;
  reportPages.summary = 1;
  renderReportTables();
}

function getFilteredReportData() {
  const filtered = reportRows.filter((row) => (
    (!$('#reportLocal').value || row.local === $('#reportLocal').value)
    && (!$('#reportWarehouse').value || row.almacen === $('#reportWarehouse').value)
    && (!$('#reportItem').value || row.item === $('#reportItem').value)
    && (!$('#reportType').value || row.tipo === $('#reportType').value)
  ));
  return { filtered, summary: consolidateByLocalItem(filtered) };
}

function renderReportTables() {
  const { filtered, summary } = getFilteredReportData();
  $('#reportSummary').textContent = `${filtered.length} combinación(es) de ${reportRows.length} · ${summary.length} fila(s) consolidadas.`;
  const masterPage = paginate(filtered, reportPages.master);
  const summaryPage = paginate(summary, reportPages.summary);
  reportPages.master = masterPage.page;
  reportPages.summary = summaryPage.page;
  $('#masterReportRows').innerHTML = filtered.length ? masterPage.rows.map((row) => `<tr><td>${cell(row.local)}</td><td>${cell(row.almacen)}</td><td>${cell(row.item)}</td><td>${cell(row.tipo)}</td><td>${formatDateTime(row.fecha)}</td><td class="stock-value">${number(row.stockActual).toFixed(3)} ${escapeHtml(row.unidad)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">No hay stock para los filtros consolidados seleccionados.</td></tr>';
  $('#summaryReportRows').innerHTML = summary.length ? summaryPage.rows.map((row) => `<tr><td>${cell(row.local)}</td><td>${cell(row.item)}</td><td>${number(row.almacenes)}</td><td class="stock-value">${number(row.stockActual).toFixed(3)} ${escapeHtml(row.unidad)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">No hay stock para los filtros consolidados seleccionados.</td></tr>';
  updateReportPagination(activeReport === 'master' ? masterPage : summaryPage);
}

function paginate(rows, requestedPage) {
  const pageSize = Number($('#reportPageSize').value);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), page, pages, total: rows.length };
}

function updateReportPagination(pageData) {
  const label = activeReport === 'master' ? 'Maestro operativo' : 'Resumen por local e ítem';
  const start = pageData.total ? (pageData.page - 1) * Number($('#reportPageSize').value) + 1 : 0;
  const end = Math.min(pageData.page * Number($('#reportPageSize').value), pageData.total);
  $('#reportPageInfo').textContent = `${label}: ${start}-${end} de ${pageData.total} · página ${pageData.page} de ${pageData.pages}`;
  $('#reportPrevious').disabled = pageData.page <= 1;
  $('#reportNext').disabled = pageData.page >= pageData.pages;
}

function changeReportPage(delta) {
  const { filtered, summary } = getFilteredReportData();
  const rows = activeReport === 'master' ? filtered : summary;
  const current = reportPages[activeReport];
  const target = paginate(rows, current + delta).page;
  if (target === current) return;
  reportPages[activeReport] = target;
  renderReportTables();
}

function consolidateByLocalItem(rows) {
  const consolidated = new Map();
  rows.forEach((row) => {
    const key = `${row.local}|${row.item}|${row.unidad}`;
    const current = consolidated.get(key) || { local: row.local, item: row.item, unidad: row.unidad, stockActual: 0, warehouses: new Set() };
    current.stockActual += number(row.stockActual);
    current.warehouses.add(row.almacen);
    consolidated.set(key, current);
  });
  return [...consolidated.values()].map((row) => ({ ...row, almacenes: row.warehouses.size })).sort((a, b) => String(a.local).localeCompare(String(b.local), 'es') || String(a.item).localeCompare(String(b.item), 'es'));
}

function showReport(name) {
  activeReport = name;
  const master = activeReport === 'master';
  $('#masterReport').hidden = !master;
  $('#summaryReport').hidden = master;
  document.querySelectorAll('[data-report]').forEach((button) => button.classList.toggle('active', button.dataset.report === name));
  renderReportTables();
}

async function searchItems(query) {
  try {
    const response = await fetch(`/cuadres-stock/api/items?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    const available = data.items.filter((item) => !selectedItems.some((selected) => selected.id === item.id && selected.type === item.type));
    $('#itemSuggestions').innerHTML = available.length
      ? available.map((item) => `<button type="button" class="suggestion" data-id="${escapeHtml(item.id)}" data-type="${escapeHtml(item.type)}" data-subtype="${escapeHtml(item.subtype ?? '')}" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}${item.code ? ` <small>${escapeHtml(item.code)}</small>` : ''}</button>`).join('')
      : '<p class="no-suggestions">Sin coincidencias.</p>';
    $('#itemSuggestions').hidden = false;
    document.querySelectorAll('.suggestion').forEach((button) => button.addEventListener('click', () => addItem({
      id: button.dataset.id, type: button.dataset.type, subtype: button.dataset.subtype || null, name: button.dataset.name,
    })));
  } catch (error) {
    setStatus(error.message || 'No se pudieron buscar los insumos.', true);
  }
}

function addItem(item) {
  if (selectedItems.length >= 5) return setStatus('Solo puedes seleccionar hasta 5 insumos o productos.', true);
  if (!selectedItems.some((selected) => selected.id === item.id && selected.type === item.type)) selectedItems.push(item);
  $('#itemSearch').value = '';
  hideSuggestions();
  renderSelectedItems();
}

function renderSelectedItems() {
  $('#selectedItems').innerHTML = selectedItems.map((item, index) => `<span class="item-chip">${escapeHtml(item.name)}<button type="button" data-index="${index}" aria-label="Quitar ${escapeHtml(item.name)}">×</button></span>`).join('');
  document.querySelectorAll('.item-chip button').forEach((button) => button.addEventListener('click', () => {
    selectedItems.splice(Number(button.dataset.index), 1);
    renderSelectedItems();
  }));
}

function hideSuggestions() { $('#itemSuggestions').hidden = true; $('#itemSuggestions').innerHTML = ''; }
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
  const header = data.header || {};
  $('#cantidad').textContent = number(header.totalCuadres ?? header.totalcuadres ?? header.cantidad ?? data.total);
  $('#sobre').textContent = money.format(number(header.cuadremanual_sobrevalorizacion ?? header.sobrevalorizacion ?? header.total_sobrevalorizacion));
  $('#perdida').textContent = money.format(number(header.cuadremanual_perdida ?? header.perdida ?? header.total_perdida));
  $('#summary').textContent = `${data.total} registro(s) encontrados · página ${data.filters.pagina}`;
  $('#rows').innerHTML = data.rows.length ? data.rows.map(rowTemplate).join('') : '<tr><td colspan="9" class="empty">No hay registros para los filtros seleccionados.</td></tr>';
}

function rowTemplate(row) {
  return `<tr><td><button type="button" class="detail-link" data-detail-id="${escapeHtml(row.cuadremanual_id)}" title="Ver detalle del cuadre ${escapeHtml(row.cuadremanual_id)}">${cell(row.cuadremanual_id)} · Ver</button></td><td>${cell(row.cuadremanual_fecha)}</td><td>${cell(row.local_descripcion ?? row.cuadremanual_local)}</td><td>${currency(row.sobrevalorizacion)}</td><td>${currency(row.perdida)}</td><td>${cell(row.cuadremanual_razon ?? row.motivo)}</td><td>${cell(row.usuario_nombre ?? row.usuario?.usuario_nombres ?? row.responsable)}</td><td>${cell(row.tipo_cuadre ?? row.tipo)}</td><td>${cell(row.estado)}</td></tr>`;
}

async function openDetail(id) {
  const dialog = $('#detailDialog');
  $('#detailTitle').textContent = `Detalle de cuadre manual #${id}`;
  $('#detailMeta').textContent = 'Cargando detalle desde Restaurant.pe…';
  $('#detailRows').innerHTML = '<tr><td colspan="10" class="empty">Cargando…</td></tr>';
  dialog.showModal();
  try {
    const response = await fetch(`/cuadres-stock/api/cuadres/${encodeURIComponent(id)}`);
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error);
    $('#detailTitle').textContent = `Detalle de cuadre manual #${detail.id}`;
    $('#detailMeta').textContent = `Registrado por: ${detail.registradoPor || '—'}${detail.usuario ? ` (${detail.usuario})` : ''} · Local: ${detail.local || '—'} · Registro: ${formatDateTime(detail.fechaRegistro)} · Cuadre: ${formatDateTime(detail.fechaCuadre)} · Ítems: ${detail.items.length}`;
    $('#detailRows').innerHTML = detail.items.length ? detail.items.map(detailRowTemplate).join('') : '<tr><td colspan="10" class="empty">Este cuadre no tiene ítems.</td></tr>';
  } catch (error) {
    $('#detailMeta').textContent = error.message || 'No se pudo cargar el detalle.';
    $('#detailRows').innerHTML = '<tr><td colspan="10" class="empty">No disponible.</td></tr>';
  }
}

function detailRowTemplate(item) {
  const quantity = (value) => value ? `${number(value).toFixed(3)} ${escapeHtml(item.unidad)}` : '—';
  const stock = (value) => `${number(value).toFixed(3)} ${escapeHtml(item.unidad)}`;
  const valuation = number(item.valorizacion);
  return `<tr><td>${cell(item.item)}<small>${cell(item.tipo)}</small></td><td>${cell(item.almacen)}</td><td class="increase">${quantity(item.aumento)}</td><td class="decrease">${quantity(item.disminuyo)}</td><td>${currency(item.costo)}</td><td>${currency(item.impuestos)}</td><td>${currency(item.total)}</td><td>${stock(item.stockAnterior)}</td><td>${stock(item.stockActual)}</td><td class="${valuation > 0 ? 'increase' : valuation < 0 ? 'decrease' : ''}">${valuation ? `${valuation > 0 ? '+' : '−'} ${currency(Math.abs(valuation))}` : '—'}</td></tr>`;
}

function cell(value) { return escapeHtml(value ?? '—'); }
function currency(value) { return value == null || value === '' ? '—' : money.format(number(value)); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function setStatus(message, isError = false) { $('#status').textContent = message; $('#status').style.color = isError ? '#bd3d3d' : ''; }
