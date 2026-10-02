markdown
# Chat con IA

Página web con un chat para hablar con Claude (Anthropic), protegida con contraseña.

## Funciones

- Respuestas en tiempo real (streaming).
- Envío de imágenes (hasta 5 por mensaje, JPEG, PNG, GIF o WebP).
- Lectura de páginas web: el asistente puede leer una URL que le des.
- Conversaciones guardadas en el servidor, que se pueden abrir y borrar.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Tu clave de la API de Anthropic |
| `APP_PASSWORD` | Sí | La contraseña para entrar al chat |
| `MODEL` | No | Modelo a usar (por defecto `claude-sonnet-5-5`) |
| `PORT` | No | Puerto del servidor (por defecto `3000`) |
| `DATA_DIR` | No | Carpeta donde se guardan las conversaciones (por defecto `/data/conversations`) |

## Desplegar en Coolify

1. Sube este proyecto a un repositorio (GitHub, GitLab, etc.).
2. En Coolify: **+ New Resource → Application** y elige tu repositorio.
3. En **Build Pack** selecciona **Dockerfile**.
4. En **Ports Exposes** pon `3000`.
5. En **Environment Variables** añade `ANTHROPIC_API_KEY` y `APP_PASSWORD`.
6. En **Persistent Storage** añade un volumen con destino `/data`.
   Sin este paso, las conversaciones se borran en cada redeploy.
7. Asigna un dominio (Coolify activa HTTPS automáticamente) y pulsa **Deploy**.

## Probar en tu ordenador (con Docker)

```bash
docker build -t chat-ia .
docker run -p 3000:3000 \
  -e ANTHROPIC_API_KEY=tu_clave \
  -e APP_PASSWORD=tu_contraseña \
  -v chat-data:/data \
  chat-ia
```

Luego abre http://localhost:3000

## Notas

- Si cambias `APP_PASSWORD`, todas las sesiones abiertas se cierran.
- Las conversaciones las ve cualquiera que conozca la contraseña: no hay usuarios separados.
- El contenedor corre como root. Si activas `USER node` en el Dockerfile, asegúrate de que el volumen `/data` tenga permisos de escritura para ese usuario.
````
