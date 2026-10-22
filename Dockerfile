# syntax=docker/dockerfile:1
# Multi-stage build: builder -> runtime (minimal)
# Build args:
#   INCLUDE_NODE=true  → instala nodejs/npm para MCP stdio (npx, uvx)

ARG INCLUDE_NODE=false

# ============================================================
# STAGE 1: builder — instala dependencias y compila bytecode
# ============================================================
FROM python:3.12-slim AS builder

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# uv versión fijada para builds reproducibles
COPY --from=ghcr.io/astral-sh/uv:0.5.30 /uv /usr/local/bin/uv

# nodejs/npm solo si se necesitan servidores MCP stdio (npx, uvx)
RUN if [ "$INCLUDE_NODE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# 1) Solo archivos de deps → capa cacheable
COPY pyproject.toml uv.lock ./

# 2) Instala dependencias en .venv (sin el proyecto, sin dev)
RUN uv sync --frozen --no-dev --no-install-project

# ============================================================
# STAGE 2: runtime — imagen mínima solo con lo necesario
# ============================================================
FROM python:3.12-slim AS runtime

ARG INCLUDE_NODE

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH=/app/src \
    PATH="/app/.venv/bin:$PATH" \
    DATA_DIR=/app/data \
    WORKSPACE_DIR=/app/workspace \
    PROJECTS_DIR=/app/projects

# Solo librerías de runtime necesarias (sin build tools)
RUN apt-get update && apt-get install -y --no-install-recommends \
      libpq5 \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# nodejs/npm en runtime solo si se necesitan MCP stdio
RUN if [ "$INCLUDE_NODE" = "true" ]; then \
      apt-get update && apt-get install -y --no-install-recommends nodejs npm \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# Copia .venv con dependencias ya instaladas (bytecode compilado)
COPY --from=builder /app/.venv ./.venv

# Copia solo el código fuente
COPY src ./src

# Usuario no-root
RUN useradd -m -u 1000 app \
    && mkdir -p /app/data /app/workspace /app/projects /app/import \
    && chown -R app:app /app
USER app

EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]