dockerfile
#FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Instalar librerías
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar el código
COPY server.js ./
COPY public ./public

# Carpeta de conversaciones (en Coolify se monta un volumen aquí)
ENV DATA_DIR=/data/conversations
RUN mkdir -p /data/conversations

# El contenedor corre como root para poder escribir en el volumen.
# Si activas USER node, da permisos antes:
#   RUN chown -R node:node /data
#USER node

ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "server.js"]
