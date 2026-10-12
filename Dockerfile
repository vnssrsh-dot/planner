FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    DB_PATH=/data/planner.db

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY planner ./planner
COPY webapp ./webapp

CMD ["python", "-m", "planner.main"]
