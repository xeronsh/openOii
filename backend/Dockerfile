# ── engine sidecar build ──────────────────────────────────────────────────────
# 编排引擎是 pi-agent-core (Node/TS)。后端首次触发生成时会拉起它，因此镜像里
# 必须同时具备 node + engine 依赖（better-sqlite3 是原生模块，需要编译工具链）。
FROM node:22-bookworm-slim AS engine

WORKDIR /engine

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY engine/package.json engine/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY engine/tsconfig.json ./
COPY engine/src ./src


# ── backend runtime ───────────────────────────────────────────────────────────
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

# Install system dependencies:
# - ffmpeg for video processing
# - libgl/libglib for opencv-python-headless
# - g++ for native extensions required by insightface during uv sync
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 g++ curl && \
    rm -rf /var/lib/apt/lists/*

# Node 运行时：engine sidecar 与后端同容器（docker-compose 单后端服务）。
COPY --from=engine /usr/local/bin/node /usr/local/bin/node
COPY --from=engine /usr/local/lib/node_modules /usr/local/lib/node_modules

RUN pip install --no-cache-dir uv

# Install deps first for better layer caching（构建上下文 = 仓库根）
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY backend/app ./app

# engine 源码 + 已装好的 node_modules（含编译好的 better-sqlite3）
COPY --from=engine /engine /engine

EXPOSE 18765

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONPATH=/app \
    ENGINE_PORT=18766

# task_manager / confirm flow依赖进程内状态，默认保持单 worker，避免恢复/取消流程失真。
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-18765} --workers ${WEB_CONCURRENCY:-1}"]
