# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \
    PYTHONPATH=/app/src \
    PATH="/app/.venv/bin:$PATH" \
    DATA_DIR=/app/data WORKSPACE_DIR=/app/workspace PROJECTS_DIR=/app/projects

# uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app

# nodejs/npm solo si usarás servidores MCP por stdio con npx
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

# dependencias primero (capa cacheable). El proyecto no se instala como paquete:
# PYTHONPATH=/app/src ya lo hace disponible y así el build no necesita descargar
# el backend de build (hatchling) desde PyPI.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# código (montado también por compose para desarrollo en caliente)
COPY src ./src

# el CLI: `kliccode` == `python -m cli`
RUN printf '#!/bin/sh\nexec /app/.venv/bin/python -m cli "$@"\n' > /usr/local/bin/kliccode \
    && chmod +x /usr/local/bin/kliccode

RUN useradd -m app \
    && mkdir -p /app/data /app/workspace /app/projects /app/import \
    && chown -R app:app /app
USER app
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
