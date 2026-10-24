FROM python:3.12-slim

WORKDIR /app

# Stdlib-only app; requirements.txt is mostly comments / optional.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt 2>/dev/null || true

COPY agents/ agents/
COPY signals/ signals/
COPY spider/ spider/
COPY ui/ ui/
COPY vendor/ vendor/
COPY run.py .
COPY README.md .

# state/ is gitignored (runtime snapshots); create empty dirs instead of COPY.
RUN mkdir -p output state/wallet_cache

ENV PYTHONUNBUFFERED=1
ENV GROK_SPIDER_ROOT=/app/vendor/polymarket-spider

EXPOSE 10000

# Render injects PORT; shell form so ${PORT} expands.
CMD python run.py --host 0.0.0.0 --port ${PORT:-10000}
