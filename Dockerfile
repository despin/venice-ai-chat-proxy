FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY venice-web-poc.mjs ./
COPY venice-openai-proxy.mjs ./
COPY venice-login.mjs ./
COPY venice-login-wreq.mjs ./
COPY venice-start.mjs ./
COPY check-proxy-models.mjs ./
COPY convert-venice-chat.mjs ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3456
ENV VENICE_SESSION_FILE=/data/.venice-web-session.json

VOLUME ["/data"]

EXPOSE 3456

CMD ["node", "./venice-start.mjs"]
