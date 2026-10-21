.PHONY: install dev cli test lint typecheck docker-build docker-up docker-down docker-cli
install:
	uv sync
dev:
	uv run uvicorn api.main:app --reload --app-dir src --port 8000
cli:
	uv run kliccode
test:
	uv run pytest -q
lint:
	uv run ruff check src tests
typecheck:
	uv run mypy src
docker-build:
	docker compose build
docker-up:
	docker compose up 
docker-down:
	docker compose down
docker-cli:
	docker compose run --rm cli
