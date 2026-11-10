# Prism Additions money tracker
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    FLASK_APP=app \
    DATABASE=/data/users.db \
    SECRET_KEY_FILE=/data/.secret_key

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt gunicorn==23.0.0

COPY app.py .
COPY templates ./templates
COPY static ./static

# Run as an unprivileged user; /data holds the database and the session key.
RUN useradd --create-home --uid 1000 app \
    && mkdir -p /data \
    && chown app:app /data
USER app
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/login', timeout=4).status == 200 else 1)"

# --preload: the database is created/upgraded once, before the workers start.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "4", \
     "--preload", "--access-logfile", "-", "app:app"]
