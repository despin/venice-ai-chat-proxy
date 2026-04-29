FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./

RUN python3 -m venv /opt/venice-login-venv \
  && /opt/venice-login-venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venice-login-venv/bin/pip install --no-cache-dir -r requirements.txt

COPY venice-web-poc.mjs ./
COPY venice-openai-proxy.mjs ./
COPY venice-login.mjs ./
COPY venice-login-curl-cffi.py ./
COPY venice-start.mjs ./
COPY check-proxy-models.mjs ./
COPY convert-venice-chat.mjs ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3456
ENV VENICE_SESSION_FILE=/data/.venice-web-session.json
ENV VENICE_PYTHON=/opt/venice-login-venv/bin/python

VOLUME ["/data"]

EXPOSE 3456

CMD ["node", "./venice-start.mjs"]
