FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY cloud_gateway/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt && groupadd --gid 10001 onsori && useradd --uid 10001 --gid 10001 --no-create-home onsori && mkdir /data && chown 10001:10001 /data
COPY --chown=10001:10001 cloud_gateway /app/cloud_gateway
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).read()"]
CMD ["uvicorn", "cloud_gateway.app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
