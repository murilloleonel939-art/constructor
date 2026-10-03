# PROYECTO.md — Chat con IA (constructor)

Contexto para retomar el proyecto en conversaciones nuevas.

## Qué es
App web de chat con Claude, protegida con contraseña, desplegada en Coolify (https://constructor.zottagroup.com). Permite guardar conversaciones, adjuntar imágenes y vincular cada conversación a un repo de GitHub para leer y editar archivos.

## Stack
- Node.js (ES modules), Express
- APIs: @anthropic-ai/sdk (Claude), openai (GPT-4-turbo) — **soporte multi-API**
- Frontend: `public/index.html` (HTML + JS sin framework)
- Respuesta en streaming (NDJSON) desde `/api/chat`

## Archivos
- `server.js` (~24 KB): servidor, API, herramientas y bucle de herramientas (máx. 6 vueltas)
- `public/index.html` (~23 KB): interfaz completa
- `Dockerfile`, `.dockerignore`, `.gitignore`, `package.json`
- `README.md`: descripción general

## Configuración (variables de entorno)
- `ANTHROPIC_API_KEY`: para Claude (Anthropic)
- `OPENAI_API_KEY`: para GPT-4-turbo (OpenAI) — **nuevo**
- `APP_PASSWORD`: contraseña de acceso
- `MODEL`: modelo por defecto (`claude-sonnet-5-5`)
- `MODELS`: lista adicional de modelos (ej: `gpt-4-turbo`; separadas por comas) — **expandido para OpenAI**
- `PORT`, `DATA_DIR` (`/data/conversations`), `PROJECTS_DIR` (`/data/projects`)

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
- (Hecho) Confirmación de commits verificada en producción: Aprobar hace el commit y Rechazar lo cancela sin commit
- (Hecho) Confirmación antes de cada commit: ver "Confirmación de commits" abajo
- (Hecho) Integración de OpenAI GPT-4-turbo:
  - ✅ Agregar `openai` a `package.json`
  - ✅ Crear cliente de OpenAI
  - ✅ Completar lógica de enrutamiento en `/api/chat` (elige API según `model.includes("gpt")` o `"claude"`)
  - ✅ Adaptar streaming NDJSON para OpenAI: acumula `delta.content` y `delta.tool_calls` de múltiples chunks
  - ✅ Bucle de herramientas para OpenAI (máx. 6 vueltas como Anthropic)
  - ✅ Confirmación de commits integrada en OpenAI también
  - 🔄 Probar que GPT-4-turbo responda correctamente (pendiente en producción)

## Selección de modelo (ACTUALIZADO)
- **Modelos disponibles:** `MODEL` (Sonnet) + `MODELS` (lista separada por comas; puede incluir OpenAI)
- **Endpoint `/api/models`:** devuelve `{ models: [...], default: MODEL }`
- **Selector en frontend:** dropdown en la cabecera, guarda elección en `localStorage` (global, no por conversación)
- **En `/api/chat`:** valida `model` contra la lista; si no es válido, usa `MODEL`
- **Enrutamiento a APIs:**
  - Si `model.includes("gpt")` → usa OpenAI SDK
  - Si `model.includes("claude")` → usa Anthropic SDK
- **Configuración por modelo (`modelParams`):**
  - **Sonnet (Claude):** `effort: "low"`, `max_tokens: 64000`, fallback beta
  - **Otros Claude:** `max_tokens: 16000` (sin `effort`, que solo Sonnet soporta)
  - **GPT-4-turbo:** `max_tokens: 4096`, parámetros básicos de OpenAI
- **Estado:** Endpoint funcionando, selector en frontend, validación en servidor. **En progreso:** completar lógica de enrutamiento OpenAI en `/api/chat`
- **Problema resuelto:** HAIKU no respondía como HAIKU porque Anthropic rechazaba `effort: "low"` (parámetro no soportado). Arreglado separando configuraciones por modelo.

## Confirmación de commits
- El servidor (`askConfirm` en `server.js`) pausa `github_guardar` y `github_editar` y envía un evento NDJSON `{type: "confirm", id, tool, path, commit, buscar, reemplazar, content}` (textos recortados a 3000 caracteres)
- El frontend muestra una tarjeta (`showConfirm` en `public/index.html`) con Aprobar / Rechazar y responde a `POST /api/confirm` con `{id, approve}`
- Rechazo = botón Rechazar, 2 minutos sin respuesta o desconexión; la IA recibe un aviso de que no reintente
- Solo se pide si el cliente envía `canConfirm: true` en `/api/chat`; no se pide si la petición ya leyó una web (el commit se bloquea de todos modos)
- Limitación: la tarjeta se añade al final del chat, así que el texto que la IA escriba después aparece en la burbuja anterior


