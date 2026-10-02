# PROYECTO.md — Chat con IA (constructor)

Contexto para retomar el proyecto en conversaciones nuevas.

## Qué es
App web de chat con Claude, protegida con contraseña, desplegada en Coolify (https://constructor.zottagroup.com). Permite guardar conversaciones, adjuntar imágenes y vincular cada conversación a un repo de GitHub para leer y editar archivos.

## Stack
- Node.js (ES modules), Express, @anthropic-ai/sdk
- Frontend: `public/index.html` (HTML + JS sin framework)
- Respuesta en streaming (NDJSON) desde `/api/chat`

## Archivos
- `server.js` (~24 KB): servidor, API, herramientas y bucle de herramientas (máx. 20 vueltas)
- `public/index.html` (~23 KB): interfaz completa
- `Dockerfile`, `.dockerignore`, `.gitignore`, `package.json`
- `README.md`: descripción general

## Configuración (variables de entorno)
`ANTHROPIC_API_KEY`, `APP_PASSWORD`, `MODEL` (por defecto `claude-sonnet-5-5`; confirmado que es el valor en uso en Coolify), `PORT`, `DATA_DIR` (`/data/conversations`), `PROJECTS_DIR` (`/data/projects`)

## Cómo funciona
- Login con cookie firmada (HMAC, 7 días) y límite de 10 intentos por IP cada 15 min
- Conversaciones guardadas como JSON en `/data/conversations`
- Un proyecto de GitHub por conversación (`/data/projects`, permisos 0600); el token solo vive en el servidor y nunca se devuelve al cliente
- Herramientas: `leer_url` (vía Jina Reader), `github_listar`, `github_leer`, `github_guardar`, `github_editar`
- Si en la petición se leyó una web, se bloquea guardar/editar en GitHub (protección contra prompt injection)
- `safePath` impide `..` y escribir en `.github/`
- `github_leer` recorta a 20.000 caracteres
- Límites: 100 mensajes, 200.000 caracteres, 5 imágenes por petición (~5 MB cada una)

## Decisiones
- Conversaciones largas: abrir una nueva y apoyarse en este archivo
- `github_editar` para cambios pequeños; `github_guardar` solo para archivos nuevos o reescrituras completas de archivos que se hayan leído enteros
- `server.js` supera el límite de lectura (20.000 caracteres): no sobrescribirlo con `github_guardar`, usar `github_editar`

## Pendiente
- (Hecho) Quitada la palabra "html" suelta al inicio de `public/index.html`
- (Hecho, sin probar en producción) Aviso en el frontend cuando el historial llega al 80 % de un límite (mensajes, caracteres o imágenes); rojo al 95 %. Función `updateLimitWarning` en `public/index.html`, con botón "Nueva conversación"
- Por verificar: que la confirmación de commits aparezca en producción (tras desplegar y recargar con Ctrl+F5)
- (Hecho) Confirmación antes de cada commit: ver "Confirmación de commits" abajo

## Confirmación de commits
- El servidor (`askConfirm` en `server.js`) pausa `github_guardar` y `github_editar` y envía un evento NDJSON `{type: "confirm", id, tool, path, commit, buscar, reemplazar, content}` (textos recortados a 3000 caracteres)
- El frontend muestra una tarjeta (`showConfirm` en `public/index.html`) con Aprobar / Rechazar y responde a `POST /api/confirm` con `{id, approve}`
- Rechazo = botón Rechazar, 2 minutos sin respuesta o desconexión; la IA recibe un aviso de que no reintente
- Solo se pide si el cliente envía `canConfirm: true` en `/api/chat`; no se pide si la petición ya leyó una web (el commit se bloquea de todos modos)
- Limitación: la tarjeta se añade al final del chat, así que el texto que la IA escriba después aparece en la burbuja anterior


