# 私募量化周刊 · 生产镜像（VPS/Docker 部署，含真实服务端鉴权）
# 适用于「github.io 仓库根目录即站点」的部署形态。
FROM python:3.12-slim

WORKDIR /app

# 仅 Python 标准库即可运行 serve.py；pandas 仅用于数据重建
RUN pip install --no-cache-dir pandas openpyxl numpy

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY index.html css js img data scripts README.md DATA_QUALITY_REPORT.md ./

# 鉴权（生产必须通过 .env / 环境变量覆盖）
ENV PE_AUTH_MODE=session \
    PE_AUTH_PASSWORD=change-me \
    PE_FORCE_SECURE=1

EXPOSE 8000
CMD ["python3", "scripts/serve.py", "--host", "0.0.0.0"]
