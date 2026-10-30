<img src="frontend/public/brand/lockup.svg" alt="Zero Smart Budget: AI-Powered Zero-Based Budgeting" width="420">

# Zero Smart Budget

**AI-Powered Zero-Based Budgeting.** A self-hosted zero-based budgeting app.

Logo files (Figtree, outlined) are in `frontend/public/brand/`: `wordmark.svg`, `wordmark-navy.svg`, `wordmark-dark.svg`, `lockup.svg`. The app version comes from `frontend/package.json`.

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
- Restoring a backup from **another server**: Settings → Data → Restore from a file… has a Backup key box for that server's `BACKUP_KEY` (used for that restore only, never saved; a key that doesn't match changes nothing). API: send it in an `X-Backup-Key` header.
With Docker, `./backups` is mounted into the API container so backups survive updates.

API: `GET /api/export`, `GET /api/export/transactions.csv?from=&to=`, `GET /api/export/budget.csv?year=&month=`,
`GET/POST /api/backups`, `GET /api/backups/<name>`, `POST /api/import?confirm=replace`.

## Run with Docker (later)

```
cp .env.example .env
docker compose up --build
```

## New version bar (release watcher)

When a newer release is published on GitHub, a slim bar shows across the top of the app:
"Version 0.3.0 is available! [See What's New] [Dismiss]". See What's New shows that release's notes;
Dismiss hides the bar until the next version. The server checks after you sign in (at most every
10 minutes) and every 3 hours (`UPDATE_CHECK_HOURS`). Turn it off, or Check now, in Settings › Data › Updates.

- Releases come from `UPDATE_REPO` (default `cwland/Corys_Dollar`). Publish a GitHub release with a tag like `v0.3.0` (and bump `version` in package.json to match) to announce a version. The release notes are what See What's New shows.
- While the repository is private, set `GITHUB_TOKEN` in `.env`: a fine-grained token for this repository only, with Contents: Read-only.
- Problems (GitHub unreachable, token refused) show in Settings › Data › Updates and in Settings › Logs.

## Turning Plaid, AI and API keys on or off

Each of the Settings tabs **Plaid**, **AI** and **API keys** starts with an on/off switch (saved right away).
Off hides that tab's settings and stops the feature, but keeps what you saved:

- **Plaid off:** no bank syncing (scheduled or Sync now) and no connecting or reconnecting banks. Connected banks and their transactions stay, shown as paused on the Accounts page.
- **AI off:** AI is never used, and AI categorization in Settings › Budget is greyed out. Your AI services are kept.
- **API keys off:** every request made with an API key is refused (and recorded in Settings › Logs). Your keys are kept.

Until you flip a switch, it follows what's set up: on if you've saved Plaid keys, AI services or API keys.
The API: `GET`/`PUT /api/settings/features` with `{ "plaid": true, "ai": false, "apiKeys": true }` (signed in only).

## Passkeys

Sign in with Touch ID, Face ID, Windows Hello or a phone instead of typing the password (the password keeps working). Add one in **Settings → Security → Passkeys** while signed in, then use **Sign in with a passkey** on the sign-in screen.

- A passkey belongs to the address it was added on: one added at `https://budget.example.com` works there, one added on `localhost` works on localhost. Add one at each address you use.
- Browsers only allow passkeys on `https://` addresses and `localhost`. A plain `http://192.168.x.x` address won't offer them.
- Behind a reverse proxy (nginx) nothing needs configuring: the address comes from the browser. Serve the app over HTTPS and keep nginx's default of passing the `Origin` header through.
- Optional: `PASSKEY_ORIGINS=https://budget.example.com` (comma-separated) only allows passkeys at those addresses.
- Passkey sign-ins show in Signed-in devices and Sign-in history. Removing a passkey in Settings stops it working here; delete it from your password manager or keychain too.

## OAuth sign-in (Authentik, Keycloak, Google…)

Set it up in **Settings → Security** (OAuth sign-in):

1. At your provider, create an OAuth2/OpenID Connect app (confidential client). Add the **Redirect URI** shown there (`https://<your app address>/api/auth/oauth/callback`).
2. In Settings → Security: turn it on, name the button (e.g. "Authentik"), enter the **issuer / discovery URL**, Client ID and Client secret. Save, then **Test connection**.
   - Authentik: `https://auth.example.com/application/o/<app-slug>/` · Keycloak: `https://kc.example.com/realms/<realm>` · Google: `https://accounts.google.com`
   - No discovery? Enter the authorize, token and user info URLs instead.
3. **Link my account**: sign in at the provider once. (Signing in with OAuth also links automatically when the provider's *verified* email matches your profile email.) Identities that aren't linked are refused.
4. Optional: **How you sign in → OAuth only** hides the password form, and the server refuses password sign-in and password resets. Passkeys still work. It can only be chosen after your account is linked.

The client secret is stored encrypted. The flow uses PKCE, state and nonce (via `openid-client`), and the session token never appears in a URL.

**Locked out?** (provider down or misconfigured) Turn password sign-in back on from the server:

```
cd backend && npm run auth:reset            # also: -- --keep-oauth to leave OAuth on
docker compose exec api npm run auth:reset   # with Docker
```

or set `EMERGENCY_DISABLE_OAUTH=true` in `.env` and restart (remove it once you're in).
