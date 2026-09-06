# API-TI (gateway)

> Este archivo es un espejo de `CLAUDE.md` en la raíz del repo -- mismo
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
