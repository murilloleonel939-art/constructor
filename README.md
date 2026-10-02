# Chat con IA

Página web con un chat para hablar con Claude (Anthropic), protegida con contraseña.

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Tu clave de la API de Anthropic |
| `APP_PASSWORD` | Sí | La contraseña para entrar al chat |
| `MODEL` | No | Modelo a usar (por defecto `claude-sonnet-5-5`) |
| `PORT` | No | Puerto del servidor (por defecto `3000`) |

## Desplegar en Coolify

1. Sube este proyecto a un repositorio (GitHub, GitLab, etc.).
2. En Coolify: **+ New Resource → Application** y elige tu repositorio.
3. En **Build Pack** selecciona **Dockerfile**.
4. En **Ports Exposes** pon `3000`.
5. En **Environment Variables** añade `ANTHROPIC_API_KEY` y `APP_PASSWORD`.
6. Asigna un dominio (Coolify activa HTTPS automáticamente) y pulsa **Deploy**.

## Probar en tu ordenador (con Docker)

```bash
docker build -t chat-ia .
docker run -p 3000:3000 -e ANTHROPIC_API_KEY=tu_clave -e APP_PASSWORD=tu_contraseña chat-ia
```

Luego abre http://localhost:3000

## Notas

- La conversación se guarda solo en la pestaña del navegador: al recargar empieza de cero.
- La sesión dura 7 días. Si cambias `APP_PASSWORD`, todos tendrán que volver a entrar.
- Tras 10 contraseñas incorrectas en 15 minutos desde la misma IP, se bloquea temporalmente.
