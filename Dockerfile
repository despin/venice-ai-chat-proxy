FROM node:22-alpine

WORKDIR /app

COPY venice-web-poc.mjs ./
COPY venice-openai-proxy.mjs ./
COPY venice-login.mjs ./
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
