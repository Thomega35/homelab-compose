FROM python:3.13-slim
RUN pip install --no-cache-dir --root-user-action=ignore "discord.py>=2.4,<3"
COPY bot.py /app/bot.py
USER nobody
CMD ["python", "-u", "/app/bot.py"]
