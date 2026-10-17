FROM python:3.13-slim
RUN pip install --no-cache-dir --root-user-action=ignore "aiohttp>=3.10,<4" "PyYAML>=6,<7"
COPY app.py /app/app.py
COPY static /app/static
USER nobody
EXPOSE 8080
CMD ["python", "-u", "/app/app.py"]
