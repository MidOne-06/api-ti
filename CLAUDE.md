# API-TI (gateway)

> Este archivo es un espejo de `AGENTS.md` en la raíz del repo -- mismo
> contenido, para que Claude Code y Codex/ChatGPT partan del mismo
> contexto. Si editás uno, actualizá el otro igual (especialmente la
> Bitácora al final).

Gateway Node.js/Playwright que expone la integración real contra
Restaurant.pe (sesiones de navegador autenticadas, no una API pública)
para el panel CRM DIMSUM. Repo remoto: `https://github.com/MidOne-06/api-ti.git`
(rama `main`). Producción: `2.25.155.29` (acceso autorizado mediante el puente `2.25.104.73`), contenedor `crm-dimsum-gateway-1`
(proyecto Docker Compose `crm-dimsum`), deploy en `/opt/API-TI`, build
requiere `STOCK_GATEWAY_PATH=/opt/API-TI` explícito. Consumido por el
panel Laravel `crm_dimsum` (`D:\DS-TI\CRM-DIMSUM\opm-digemid`).

Este proyecto se edita con más de una herramienta de IA (Claude Code y
Codex/ChatGPT, al menos). Las reglas de abajo existen porque ya hubo
fricción real por trabajar sin ellas en el repo hermano `crm_dimsum`:
una herramienta dejó cambios sin commitear mientras la otra trabajaba
en el mismo árbol, y solo se descubrió por accidente. Aplican igual acá.

## Reglas de convivencia entre herramientas

**Antes de empezar a editar cualquier archivo:**
1. `git status --short` -- el árbol debe estar limpio. Si hay cambios
   sin commitear que no son tuyos de esta sesión, **no los toques, no
   los descartes** (nunca `git stash`/`git checkout --` sobre trabajo
   ajeno) -- repórtalo al usuario y esperá instrucción.
2. `git pull` -- traé lo que la otra herramienta ya haya subido.

**Al terminar una sesión de trabajo (o antes de que el usuario abra la
otra herramienta):**
3. Commitear y hacer `git push` de lo que quedó terminado y probado.
   No dejar el árbol sucio "para después" -- la próxima sesión (con
   cualquiera de las dos herramientas) parte de ahí.
4. Agregar una entrada corta en la Bitácora de abajo: qué se hizo, qué
   quedó pendiente, y cualquier advertencia que la próxima sesión
   necesite saber.

**Si vas a trabajar en paralelo de verdad** (no por turnos, sino con
las dos herramientas activas al mismo tiempo): usar una rama por
herramienta (`claude/<tema>`, `codex/<tema>`) y mergear a `main`
cuando cada una termine, en vez de compartir el mismo checkout local.

**Producción solo se despliega por versión, nunca copiando el disco
local.** El deploy de este repo va siempre atado al deploy del panel
CRM DIMSUM -- ver el skill `deploy-produccion` en ese repo
(`D:\DS-TI\CRM-DIMSUM\opm-digemid\.claude\skills\deploy-produccion\`)
para el flujo completo.

## Bitácora

Formato: `AAAA-MM-DD · herramienta · qué se hizo · qué queda pendiente/advertencias`.
Agregar entradas nuevas al final. No editar entradas viejas salvo para
corregir un error real.

- 2026-09-03 · Claude Code · Guías internas: nuevos endpoints `/api/estados` y `/api/contexto-filtros`; `items()` devuelve `item_tipo`; `guideListFilter` conecta `itemIdList`/`itemTipoList`/`filtroPorFecha` a los valores reales de la solicitud en vez de dejarlos vacíos/fijos. · Ninguno.
- 2026-09-06 · Codex · Movimientos entre almacenes: gateway en tiempo real contra los endpoints nativos `movimiento/obtenerListaDeMovimientos` y `obtenerCabeceraListaDeMovimientos`; no persiste movimientos en la base local. · Pendiente validar visualmente el módulo CRM publicado.
- 2026-09-06 · Codex · Movimientos entre almacenes: endpoint protegido `POST /api/movimientos/{id}/editar` mapeado a `movimiento/actualizarMovimiento`; relee el movimiento y conserva los detalles remotos antes de aplicar los campos cabecera del formulario nativo. · No ejecutar POST sobre movimientos operativos sin autorización explícita para modificar ese registro.
- 2026-09-06 · Codex · Corrección de payload de Movimientos entre almacenes: Restaurant anula con `listProductos` de la fila del listado y edita con `obtenerFormatoDetalleMovimientoBackend`; el gateway replica ambos contratos en vez de enviar el detalle crudo. · Las operaciones reales deben confirmarse en Restaurant antes de anunciar éxito.
- 2026-09-06 · Codex · Detalle de Movimientos entre almacenes ahora publica un contrato `editor` derivado de `obtenerMovimiento/{id}` (local, almacenes, tipo e ítems) y edición replica cambios permitidos de cantidad antes de formatear el payload nativo. · No tratar los objetos crudos de Restaurant como contrato público ni editar almacenes hasta mapear sus selectores vinculados.
- 2026-09-06 · Codex · Editor de movimientos: almacenes de origen/destino pasan a cargarse en vivo por el tráfico nativo `common/almacen/getAll/-1/1/0/0`, limitado a locales permitidos de la sesión. Al guardar se resuelven nuevamente los objetos de almacén desde Restaurant antes de armar `actualizarMovimiento`. · No sustituir este catálogo por BD local o constantes.
- 2026-09-06 · Codex · Edición de Movimientos entre almacenes: el gateway expone metadatos de ítems, admite agregar/quitar detalles además de actualizar cantidades y normaliza el payload al formato `actualizarMovimiento` de Restaurant. · No ejecutar Guardar sobre movimientos operativos durante la validación.
- 2026-09-06 · Codex · Corrección del editor: el tráfico real de búsqueda devuelve `unidadmedidainsumo_descripcion`; el gateway ahora lo asigna al campo Unidad de los ítems nuevos, sin catálogo ni texto estático. · Validado con el ítem SM002 en el local 1.
- 2026-09-06 · Codex · Edición de movimientos: se replica la previsualización nativa `emularCambioStockEnMovimientos/2/4` y se reenvía `data.movimientos` en `emulacionMovimiento` antes de `actualizarMovimiento`; corrige el rechazo remoto `productos is not defined`. · Validar el flujo visual sin ejecutar una actualización operativa.
- 2026-09-06 · Codex · El detalle de edición reconstruye el objeto vivo `unidadmedidainsumo` para ítems nuevos, igual que el contrato nativo de Logística. · La prueba de guardado queda pendiente de autorización operativa.
- 2026-09-06 · Codex · Corrección controlada del editor: el payload usaba la abreviatura `productos` sin declarar mientras la variable real era `products`; ahora ambos endpoints reciben explícitamente `productos: products` y se registran las etapas de emulación/actualización. · Validar en producción con emulación de solo lectura; no guardar movimientos operativos.
- 2026-09-06 · Codex · El editor normaliza `fecha` al formato nativo `YYYY-MM-DD HH:mm:ss` (incluido el caso ISO con `T` o sin segundos) antes de actualizar. · No ejecutar guardados operativos durante la validación.
- 2026-09-06 · Codex · Alta de movimientos: el guardado replica validar stock → emular → agregar; los catálogos de locales, almacenes e ítems se consultan en Restaurant en cada interacción. · La persistencia sólo ocurre con el POST confirmado por el usuario; no usarla como prueba automática.
- 2026-09-07 · Codex · Alta de movimientos: el selector Tipo de movimiento consulta el bundle activo de Restaurant y publica sus opciones nativas (Traslado/Devolución); previsualización y guardado validan el código vivo antes de enviarlo. · No reemplazar este origen por valores estáticos en CRM.
- 2026-09-07 · Codex · Editor de movimientos: el tipo se carga de la constante vigente TIPOMOVIMIENTO del bundle de Restaurant, se presenta como selector nativo y se valida/reenvía al actualizar. · No guardar como prueba; usar únicamente previsualización/emulación si se requiere validar.
- 2026-09-07 · Codex · Canje de guías internas: se registran etapas explícitas de validación, hidratación, stock, emulación y persistencia para identificar sin ambigüedad un rechazo de Restaurant sin repetir la operación. · El registro real sólo se ejecuta tras `confirmar: true`.
- 2026-09-07 · Codex · Altas y canjes de movimientos ahora emulan con `emularCambioStockEnMovimientos/1/4` (REGISTRO), igual que el controlador nativo; `/2/4` corresponde sólo a MODIFICACIÓN. · La emulación de la guía 5888 devolvió dos movimientos sin persistir datos.
- 2026-09-07 · Codex · Canje de guías conserva `cantidadPresentacion` y `item_cantidad_aux` al construir los detalles, igual que `obtenerFormatoDetalleMovimientoBackend` de Logística. · Evita perder datos de presentación/cantidad original al emular y registrar.
