FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --omit=dev

COPY src/ src/
COPY scripts/ scripts/
COPY check/models.mjs check/
COPY index.mjs ./

# The image has no .git, so /support/info reports the commit from build args.
ARG VENICE_BUILD_COMMIT=""
ARG VENICE_BUILD_BRANCH=""
ENV VENICE_BUILD_COMMIT=$VENICE_BUILD_COMMIT
ENV VENICE_BUILD_BRANCH=$VENICE_BUILD_BRANCH

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3456
ENV VENICE_SESSION_FILE=/data/.venice-web-session.json

VOLUME ["/data"]

EXPOSE 3456

CMD ["node", "./index.mjs"]
