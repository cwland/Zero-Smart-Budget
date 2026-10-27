# Cory's Dollar

A self-hosted zero-based budgeting app.

## Run locally on a Mac (no Docker)

One-time setup:
```
brew install postgresql@16
brew services start postgresql@16
createdb corysdollar
cp backend/.env.example backend/.env    # then put your Mac username in DATABASE_URL
npm run setup
```

Start the app:
```
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000/api/health

## Run with Docker (later)

```
cp .env.example .env
docker compose up --build
```
