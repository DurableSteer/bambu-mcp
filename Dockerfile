FROM node:24-alpine AS build

WORKDIR /src

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build
RUN npm prune --omit=dev && npm install --omit=dev mcp-proxy


FROM node:24-alpine

WORKDIR /app

COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/dist ./dist

RUN mkdir -p /home/node/.bambu-mcp && chown -R node:node /home/node

USER node

ENV HOME=/home/node
ENV BAMBU_MCP_SIMULATION=1

EXPOSE 8080

CMD ["node_modules/.bin/mcp-proxy", "--port", "8080", "--host", "0.0.0.0", "--", "node", "dist/index.js"]
