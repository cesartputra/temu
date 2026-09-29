FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8080
COPY server/ ./server/
COPY dist/ ./dist/
COPY deploy/start.sh ./deploy/start.sh
EXPOSE 8080
CMD ["sh", "/app/deploy/start.sh"]
