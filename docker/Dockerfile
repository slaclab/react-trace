FROM node:24-alpine AS build

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

ARG VITE_BASE_PATH=/trace/
ARG VITE_CANOPY_BASE_PATH=/trace/api/canopy
ENV VITE_BASE_PATH=$VITE_BASE_PATH
ENV VITE_CANOPY_BASE_PATH=$VITE_CANOPY_BASE_PATH

RUN pnpm build

FROM nginx:1.29-alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /app/nginx.conf.template
COPY docker/start-nginx.sh /app/start-nginx.sh

RUN chmod 0555 /app/start-nginx.sh

USER 101

EXPOSE 8080

ENTRYPOINT ["/app/start-nginx.sh"]
