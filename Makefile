.PHONY: install dev test lint typecheck
install:
	uv sync
dev:
	uv run uvicorn api.main:app --reload --app-dir src --port 8000
test:
	uv run pytest -q
lint:
	uv run ruff check src tests
typecheck:
	uv run mypy src
