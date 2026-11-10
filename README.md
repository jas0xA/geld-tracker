# Geld Tracker

Track spending and earnings, recurring payments (salary, rent, subscriptions),
your card and cash balance, and a forecast up to a year ahead.

## Run on a server with Docker

The image is built automatically on every push to `master` and published to
`ghcr.io/jas0xa/geld-tracker`.

```bash
# 1. Get the compose file (or clone the repo)
curl -O https://raw.githubusercontent.com/jas0xA/geld-tracker/master/docker-compose.yml

# 2. Start it
docker compose up -d

# 3. Create your admin account (asks for a password)
docker compose exec geld-tracker flask create-admin YOURNAME you@example.com
```

Open `http://your-server:8000` and sign in. Use the **Admin** page to authorise
the email addresses that may create an account.

### Update to the newest version

```bash
docker compose pull && docker compose up -d
```

Your data lives in the `geld-data` volume and is kept across updates.

### Settings (in `docker-compose.yml`)

| Variable        | Meaning |
|-----------------|---------|
| `COOKIE_SECURE` | `1` when the site is served over HTTPS. |
| `BEHIND_PROXY`  | `1` when it runs behind a reverse proxy (nginx, Caddy, Traefik) so the real client IP and HTTPS are detected. |

### Backup

```bash
docker compose exec geld-tracker python -c "import sqlite3; s=sqlite3.connect('/data/users.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d)"
docker compose cp geld-tracker:/data/backup.db ./backup.db
```

## Run locally without Docker

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/flask --app app create-admin YOURNAME you@example.com
.venv/bin/python app.py
```
