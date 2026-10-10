# syntax=docker/dockerfile:1
#
# Container image: the built app served by `vite preview`, which runs the same
# provider routes as the dev server. Keys are not baked in: pass them as
# environment variables at run time. See docs/SELF-HOSTING.md.
#
#   docker build -t gods-eye-view .
#   docker run --rm -p 4173:4173 --env-file .env gods-eye-view

ARG NODE_VERSION=24

# The built bundle is the same on every architecture, so build it once on the
# build host instead of under emulation.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-slim AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# `vite preview` loads the Vite config and its provider plugins, which need
# the full dependency tree (including native esbuild/rollup builds for this
# architecture) and the source tree next to the bundle.
FROM node:${NODE_VERSION}-slim
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=4173
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY . .
COPY --from=build /app/dist ./dist
# Writable at run time: provider caches, the voice debug log, and Vite's
# bundled copy of the config.
RUN mkdir -p .gev-cache .gev-logs node_modules/.vite-temp \
    && chown -R node:node .gev-cache .gev-logs node_modules/.vite-temp
USER node
EXPOSE 4173
VOLUME ["/app/.gev-cache"]
CMD ["sh", "-c", "exec node_modules/.bin/vite preview --host \"$HOST\" --port \"$PORT\" --strictPort"]
