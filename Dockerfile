# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1
# uv 
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app

# nodejs/npm solo si usarás servidores MCP por stdio con npx
RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY src ./src
RUN uv sync --frozen --no-dev --no-install-project

RUN useradd -m app && mkdir -p /app/data /app/workspace /app/projects && chown -R app /app
USER app
EXPOSE 8000
CMD ["uv", "run", "--no-sync", "uvicorn", "api.main:app", "--app-dir", "src", \
    "--host", "0.0.0.0", "--port", "8000"]
