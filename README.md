# Zero Smart Budget

**AI-Powered Zero-Based Budgeting.** A self-hosted zero-based budgeting app.

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

Every route except `/api/health` and the login routes needs one of:
- `Authorization: Bearer <token>` (from logging in), or
- `X-API-Key: <key>` (create keys in **Settings → API keys**)

Money is always in whole cents (`$10.50` = `1050`). Dates are `YYYY-MM-DD`.

| Method | Route | What it does |
|---|---|---|
| GET | `/api/health` | Health check (no login) |
| GET | `/api/auth/status` | `{ setupRequired }` (no login) |
| POST | `/api/auth/setup` | Create the one account on first run (no login) |
| POST | `/api/auth/login` | `{ username, password }` → `{ token }` (no login) |
| GET | `/api/auth/me` | Who's calling |
| POST | `/api/auth/password` | `{ currentPassword, newPassword }` → new token; signs out other devices (login only) |
| POST | `/api/auth/logout-all` | Sign out everywhere; `{ keepThisDevice: true }` returns a new token (login only) |
| POST | `/api/auth/forgot` | Email a reset link (no login; needs email set up) |
| POST | `/api/auth/reset` | `{ token, newPassword }` → signs in (no login) |
| PATCH | `/api/profile` | `{ username?, displayName?, email? }` (login only) |
| GET / PUT / DELETE | `/api/settings/email` | Email settings (password never returned; login only) |
| POST | `/api/settings/email/test` | Send a test email, optionally with unsaved `settings` and a `to` address (login only) |
| GET / POST / DELETE | `/api/keys`, `/api/keys/:id` | List / create (key shown once) / revoke API keys (login only) |
| GET | `/api/months` | Months that have a budget |
| GET | `/api/months/:year/:month` | Full budget with planned/spent/remaining, or `{ exists: false }` |
| POST | `/api/months/:year/:month` | Create a month: `{ mode: "blank" \| "template" \| "copy" }` |
| DELETE | `/api/months/:id` | Delete a month |
| POST | `/api/months/:id/income` | Add income item `{ name, plannedCents }` |
| PATCH / DELETE | `/api/income/:id` | Edit / delete income item |
| PUT | `/api/months/:id/income/order` | Reorder income `{ ids: [...] }` |
| POST | `/api/months/:id/groups` | Add group `{ name }` |
| PATCH / DELETE | `/api/groups/:id` | Rename / delete group |
| PUT | `/api/months/:id/groups/order` | Reorder groups `{ ids: [...] }` |
| POST | `/api/groups/:id/items` | Add line item `{ name, plannedCents, sinkingFundId? }` |
| PATCH / DELETE | `/api/items/:id` | Edit (`name`, `plannedCents`, `sinkingFundId`, `groupId` to move) / delete |
| PUT | `/api/groups/:id/items/order` | Reorder items `{ ids: [...] }` |
| GET | `/api/transactions` | Filters: `year&month`, `from&to`, `unassigned=true`, `lineItemId` |
| POST | `/api/transactions` | `{ date, merchant, amountCents, type: "expense"\|"income", note?, splits: [{ lineItemId \| incomeItemId, amountCents }] }` (empty splits = unassigned) |
| GET | `/api/transactions/suggest` | `merchant`, `date`, `type`, `amountCents?` → suggested item |
| POST | `/api/transactions/:id/accept-suggestion` | Assign to its suggestion |
| POST | `/api/transactions/accept-suggestions` | `{ ids: [...] }` → accept many |
| GET | `/api/merchants` | `q` → past merchants for autocomplete |
| GET / PUT / DELETE | `/api/transactions/:id` | Get / replace (incl. splits) / delete |
| GET | `/api/funds` | Sinking funds with balances (`year&month`, `includeArchived=true`) |
| POST / PATCH / DELETE | `/api/funds`, `/api/funds/:id` | Create / edit (incl. `archived`) / delete |
| GET | `/api/export` | Everything as JSON |
| GET | `/api/export/transactions.csv` | Transactions CSV (`from`, `to`) |
| GET | `/api/export/budget.csv` | Budget CSV (`year`, `month`) |
| GET / POST | `/api/backups` | List backups / back up now |
| GET | `/api/backups/:name` | Download a backup |
| POST | `/api/import?confirm=replace` | Restore from an export/backup (login only; replaces all budget data) |

## Favorites

Star any budget item from its details panel to pin it to a **Favorites** card right below Income
(like EveryDollar). It's the same item, not a copy: edit the planned amount there or in its group.
Favorites carry into a copied month and show first in the Add Transaction picker.

## Suggestions (learned categories)

- Unassigned transactions show a dashed **+ Item** chip, the item you used for the same merchant before. Click it to accept, or **Accept all suggestions**.
- Merchants are matched after stripping bank noise (card/ref numbers, dates, ACH/POS/DEBIT…), with a fallback on the first two words.
- If a merchant goes to different items in the same month (e.g. Paycheck 1 on the 1st, Paycheck 2 on the 15th), the closest day of month and amount wins; otherwise the most recent assignment wins.
- The Add Transaction form autocompletes past merchants and pre-picks their item.
- API: send `"autoAssign": true` with `POST /api/transactions` to put known merchants straight on their item.

Turn this off with **Settings > Budget > Fast Track**. While it's off there are no suggestion chips and nothing is auto-assigned.

## Accounts and passwords

- **Account menu** (your initials, bottom-left; "Account" on phones): Profile & security, Sign out, Sign out everywhere.
- **Settings** is split into tabs: Profile, Security, API keys, Email, Data.
- Changing your password signs out every other device (this one stays signed in).
- **Email** is set up in **Settings → Email**: pick a provider (Gmail, Outlook, iCloud, Fastmail, or custom), enter the login, and use **Send test email** before saving. The SMTP password is stored encrypted (keyed from `JWT_SECRET`) and never sent back to the browser. `SMTP_*` / `MAIL_FROM` / `APP_URL` in `.env` still work as a fallback when nothing is saved in the app.
- **Forgot password?** shows on the sign-in page when email is on, the app address is set, and your profile has an email. Reset links work once, for 1 hour.
- **Locked out without email?** Run on the server:
  ```
  cd backend && npm run reset-password
  # Docker: docker compose exec api npm run reset-password
  ```

## Export and backups

Settings (gear icon) has:
- **Export**: everything as JSON, or transactions / budget as CSV
- **Backups**: one is saved automatically each day to `backups/` (the newest 30 are kept). "Back up now" makes one on demand.
- **Restore**: load a backup or JSON export. This replaces all budget data, but your login is kept and a `-before-restore` backup is saved first.

Settings in `backend/.env`: `BACKUP_ENABLED`, `BACKUP_KEEP`, `BACKUP_DIR`, `BACKUP_KEY`.

**Settings in backups.** Backups (and the "Everything (JSON)" export) include your settings: budget, notifications, AI services, email server and Plaid keys. Not included: your login, API keys, signed-in devices, and bank connections.
Saved keys and passwords (AI keys, the email password, Plaid secrets) are included only when `BACKUP_KEY` is set, encrypted with it (AES-256-GCM), never in plain text. Without it, backups still have your settings but leave those out, and Settings → Data says so.
- Make a key with `openssl rand -base64 32` and put `BACKUP_KEY=...` in `.env` (Docker; `env_file` passes it to the API) or `backend/.env` (npm). Restart the API.
- **Save a copy of the key somewhere safe, away from the server** (a password manager is ideal). It can't be recovered: without it, the keys and passwords in your backups can't be restored. Restoring on another server needs the same `BACKUP_KEY` (a different `JWT_SECRET` there is fine).
- If a key or password can't be read on restore, the one already saved on this server is kept; otherwise it has to be entered again.
With Docker, `./backups` is mounted into the API container so backups survive updates.

API: `GET /api/export`, `GET /api/export/transactions.csv?from=&to=`, `GET /api/export/budget.csv?year=&month=`,
`GET/POST /api/backups`, `GET /api/backups/<name>`, `POST /api/import?confirm=replace`.

## Run with Docker (later)

```
cp .env.example .env
docker compose up --build
```
