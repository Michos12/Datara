# syntax=docker/dockerfile:1
# Build context: services/analytics

FROM python:3.13-slim AS base
COPY --from=ghcr.io/astral-sh/uv:0.11.14 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1
WORKDIR /app

# Dependencies first (cached unless the lockfile changes), then the project itself.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY insights ./insights
RUN uv sync --frozen --no-dev

RUN useradd --system --uid 10001 --no-create-home insights
USER insights
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; urllib.request.urlopen('http://127.0.0.1:8000/internal/health', timeout=2)" || exit 1

CMD ["uvicorn", "insights.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
