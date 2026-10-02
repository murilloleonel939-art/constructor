Chat con IA (constructor)
Qué es

App web de chat con Claude, protegida con contraseña, desplegada en Coolify (https://constructor.zottagroup.com). Permite guardar conversaciones, adjuntar imágenes y vincular cada conversación a un repo de GitHub para leer y editar archivos.

Stack
Node.js (ES modules), Express, @anthropic-ai/sdk
Frontend: public/index.html (HTML + JS sin framework)
Respuesta en streaming (NDJSON) desde /api/chat
Archivos
server.js: servidor, API, herramientas y bucle de herramientas (máx. 5 vueltas)
public/index.html: interfaz completa
Configuración (variables de entorno)

ANTHROPIC_API_KEY, APP_PASSWORD, MODEL (por defecto claude-sonnet-5-5), PORT, DATA_DIR (/data/conversations), PROJECTS_DIR (/data/projects)

Cómo funciona
Login con cookie firmada (7 días) y límite de intentos por IP
Conversaciones guardadas como JSON en el volumen /data/conversations
Un proyecto de GitHub por conversación; el token solo vive en el servidor
Herramientas: leer_url, github_listar, github_leer, github_guardar, github_editar
Si se leyó una web en la petición, se bloquea guardar/editar en GitHub (seguridad)
Límites: 100 mensajes, 200.000 caracteres, 5 imágenes por petición
Decisiones
Conversaciones largas: abrir una nueva y apoyarse en este archivo
github_editar para cambios pequeños; github_guardar solo para archivos nuevos
Pendiente
Quitar la palabra "html" suelta al inicio de public/index.html
Posibles mejoras: aviso en el frontend cuando el historial se acerca al límite, confirmación antes de cada commit
