FROM node:18-alpine

WORKDIR /app

COPY backend/package*.json ./
RUN npm install --production 2>&1 | tail -5

COPY backend/ ./backend/
COPY frontend/ ./frontend/

WORKDIR /app/backend

ENV PORT=3011
ENV NODE_ENV=production

EXPOSE 3011

CMD ["node", "server.js"]
