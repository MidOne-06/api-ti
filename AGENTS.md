# API-TI (gateway)

> Este archivo es un espejo de `CLAUDE.md` en la raíz del repo -- mismo
> contenido, para que Claude Code y Codex/ChatGPT partan del mismo
> contexto. Si editás uno, actualizá el otro igual (especialmente la
> Bitácora al final).

Gateway Node.js/Playwright que expone la integración real contra
Restaurant.pe (sesiones de navegador autenticadas, no una API pública)
para el panel CRM DIMSUM. Repo remoto: `https://github.com/MidOne-06/api-ti.git`
(rama `main`). Producción: `2.25.104.73`, contenedor `crm-dimsum-gateway-1`
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
