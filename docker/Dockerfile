FROM node:24-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

ARG VITE_BASE_PATH=/trace/
ARG VITE_CANOPY_BASE_PATH=/trace/api/canopy
# Empty means the app's defaults: this repo's GitHub issues and public docs site.
# A config.json's header.bugReportUrl and header.docsUrl override them at runtime.
ARG VITE_BUG_REPORT_URL=
ARG VITE_DOCS_URL=
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_CANOPY_BASE_PATH=$VITE_CANOPY_BASE_PATH
ENV VITE_BUG_REPORT_URL=$VITE_BUG_REPORT_URL
ENV VITE_DOCS_URL=$VITE_DOCS_URL

RUN pnpm build

FROM nginx:1.29-alpine

# dist/ carries a neutral config.json (the built-in site defaults). A
# deployment sets its own without a rebuild by mounting a file over it, e.g.
#   -v ./config.json:/usr/share/nginx/html/config.json:ro
# (docs/site-defaults.md; every key in config.example.json).
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /app/nginx.conf.template
COPY docker/start-nginx.sh /app/start-nginx.sh

RUN chmod 0555 /app/start-nginx.sh

USER 101

EXPOSE 8080

ENTRYPOINT ["/app/start-nginx.sh"]
