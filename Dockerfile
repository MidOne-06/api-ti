# syntax=docker/dockerfile:1.7

# Imagen oficial de Playwright: ya trae Chromium + todas las libs de sistema
# que necesita para correr headless (evita tener que instalarlas a mano en
# una imagen node:alpine, que no las trae y falla en runtime).
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
