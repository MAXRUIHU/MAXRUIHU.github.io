# 私募量化周刊 · 生产镜像（含服务端鉴权）
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts ./scripts
COPY public ./public
COPY data ./data
COPY README.md DATA_QUALITY_REPORT.md ./

# 鉴权（生产必须设置）
ENV PE_AUTH_MODE=session \
    PE_AUTH_PASSWORD=change-me \
    PE_FORCE_SECURE=1

EXPOSE 8000
CMD ["python3", "scripts/serve.py", "--host", "0.0.0.0"]
