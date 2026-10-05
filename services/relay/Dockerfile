FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.mjs ./
USER node
ENV RELAY_BIND=0.0.0.0 PORT=8788
EXPOSE 8788
CMD ["node", "server.mjs"]
