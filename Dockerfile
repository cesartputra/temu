FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
COPY server/ ./server/
COPY dist/ ./dist/
COPY deploy/start.sh ./deploy/start.sh
EXPOSE 8080
CMD ["sh", "/app/deploy/start.sh"]
