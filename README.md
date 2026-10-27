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

## Export and backups

Settings (gear icon) has:
- **Export**: everything as JSON, or transactions / budget as CSV
- **Backups**: one is saved automatically each day to `backups/` (the newest 30 are kept). "Back up now" makes one on demand.
- **Restore**: load a backup or JSON export. This replaces all budget data, but your login is kept and a `-before-restore` backup is saved first.

Settings in `backend/.env`: `BACKUP_ENABLED`, `BACKUP_KEEP`, `BACKUP_DIR`.
With Docker, `./backups` is mounted into the API container so backups survive updates.

API: `GET /api/export`, `GET /api/export/transactions.csv?from=&to=`, `GET /api/export/budget.csv?year=&month=`,
`GET/POST /api/backups`, `GET /api/backups/<name>`, `POST /api/import?confirm=replace`.

## Run with Docker (later)

```
cp .env.example .env
docker compose up --build
```
