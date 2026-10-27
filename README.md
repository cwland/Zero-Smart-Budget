# Cory's Dollar

A self-hosted zero-based budgeting app.

## Run locally on a Mac (no Docker)

One-time setup:
```
brew install postgresql@16
brew services start postgresql@16
createdb corysdollar
createdb corysdollar_test     # used by npm test
cp backend/.env.example backend/.env    # then put your Mac username in DATABASE_URL
npm run setup
```

Start the app:
```
npm run dev
```

- Web: http://localhost:5173
- API: http://localhost:4000/api/health

The database tables are created automatically when the API starts.

## Tests

```
npm test
```

## Changing the database

Edit `backend/src/db/schema.ts`, then:
```
cd backend
npm run db:generate
```
The new migration in `backend/drizzle/` is applied next time the API starts.

## API

Every route except `/api/health` and login needs either:
- `Authorization: Bearer <token>` (from logging in), or
- `X-API-Key: <key>` (create keys at `POST /api/keys`)

Money is always in whole cents (`$10.50` = `1050`).

## Run with Docker (later)

```
cp .env.example .env
docker compose up --build
```
