FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml README.md ./
COPY engine ./engine
RUN pip install .
# Render/Cloud Run give the port in $PORT
CMD ["sh", "-c", "uvicorn engine.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
