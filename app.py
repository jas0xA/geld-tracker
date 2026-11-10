import os
import re
import secrets
import time as time_mod
from datetime import datetime, date, time, timedelta
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import wraps
import calendar
import json

import click
from peewee import *
from flask import (Flask, render_template, request, redirect, url_for, flash,
                   session, g, abort, jsonify)
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def load_secret_key():
    """SECRET_KEY env var, else a key persisted in .secret_key (so sessions survive restarts)."""
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    path = os.path.join(BASE_DIR, ".secret_key")
    if os.path.exists(path):
        with open(path) as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)
    return key


app = Flask(__name__)
app.secret_key = load_secret_key()
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE") == "1",  # set when served over HTTPS
    MAX_CONTENT_LENGTH=64 * 1024,
    # "Keep me signed in" keeps the session cookie for 30 days instead of until the browser closes.
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    SESSION_REFRESH_EACH_REQUEST=True,
)
db = SqliteDatabase(os.environ.get("DATABASE", os.path.join(BASE_DIR, "users.db")),
                    pragmas={"foreign_keys": 1})

# Checked when the username doesn't exist, so timing doesn't reveal valid usernames.
DUMMY_HASH = generate_password_hash("dummy-password")

CATEGORIES = ["Food & drink", "Groceries", "Housing", "Transport", "Shopping", "Subscriptions",
              "Health", "Entertainment", "Bills", "Salary", "Other"]
FREQUENCIES = {"once": "Once", "weekly": "Every week", "biweekly": "Every 2 weeks",
               "monthly": "Every month", "yearly": "Every year"}
PER_MONTH = {"weekly": Decimal(52) / 12, "biweekly": Decimal(26) / 12,
             "monthly": Decimal(1), "yearly": Decimal(1) / 12}
METHODS = ("card", "cash")
# Euro notes and coins, in cents.
NOTES = [50000, 20000, 10000, 5000, 2000, 1000, 500]
COINS = [200, 100, 50, 20, 10, 5, 2, 1]
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
MAX_CENTS = 100_000_000_00  # 100 million


# ---------------------------------------------------------------- models

class BaseModel(Model):
    class Meta:
        database = db


class User(BaseModel):
    name = CharField(unique=True)
    email = CharField(null=True, unique=True)
    password = CharField()  # werkzeug hash (scrypt), never plaintext
    is_admin = BooleanField(default=False)


class AllowedEmail(BaseModel):
    """Emails an admin has authorised to create an account."""
    email = CharField(unique=True)
    added_by = ForeignKeyField(User, null=True, on_delete="SET NULL")
    added_at = DateTimeField(default=datetime.now)


class Category(BaseModel):
    """A user's own category, on top of the built-in CATEGORIES."""
    user = ForeignKeyField(User, backref="categories", on_delete="CASCADE")
    name = CharField(max_length=32)

    class Meta:
        indexes = ((("user", "name"), True),)


class Recurring(BaseModel):
    """A repeating (or one-off planned) payment: subscriptions, rent, salary..."""
    user = ForeignKeyField(User, backref="recurring", on_delete="CASCADE")
    kind = CharField()  # "income" | "expense"
    amount_cents = IntegerField()
    description = CharField()
    category = CharField(default="Other")
    method = CharField(default="card")
    frequency = CharField()  # key of FREQUENCIES
    anchor_day = IntegerField()  # day of month to keep for monthly/yearly (31 -> last day in short months)
    next_date = DateField()  # next date it will be booked
    end_date = DateField(null=True)
    active = BooleanField(default=True)
    created_at = DateTimeField(default=datetime.now)


class Transaction(BaseModel):
    user = ForeignKeyField(User, backref="transactions", on_delete="CASCADE")
    kind = CharField()  # "income" | "expense"
    amount_cents = IntegerField()
    description = CharField(default="")
    category = CharField(default="Other")
    method = CharField(default="card")  # "card" | "cash"
    recurring = ForeignKeyField(Recurring, null=True, on_delete="SET NULL")
    created_at = DateTimeField(default=datetime.now, index=True)


class BalanceSnapshot(BaseModel):
    """The balance the user counted at a moment. Later transactions are added on top."""
    user = ForeignKeyField(User, backref="balances", on_delete="CASCADE")
    card_cents = IntegerField()
    cash_cents = IntegerField()
    cash_detail = TextField(default="{}")  # JSON: {"counts": {cents: n}, "typed": cents}
    set_at = DateTimeField(default=datetime.now, index=True)


def _add_missing_columns(table, columns):
    if not db.table_exists(table):
        return
    have = {c.name for c in db.get_columns(table)}
    for name, ddl in columns:
        if name not in have:
            db.execute_sql(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {ddl}')


def init_db():
    db.connect(reuse_if_open=True)
    # Upgrade older databases. This must run BEFORE create_tables, which would otherwise
    # try to index columns that aren't there yet.
    _add_missing_columns("user", [("email", "VARCHAR(255)"),
                                  ("is_admin", "INTEGER NOT NULL DEFAULT 0")])
    _add_missing_columns("transaction", [("method", "VARCHAR(255) NOT NULL DEFAULT 'card'"),
                                         ("recurring_id", 'INTEGER REFERENCES "recurring" ("id") ON DELETE SET NULL')])
    db.create_tables([User, AllowedEmail, Category, Recurring, Transaction, BalanceSnapshot])
    db.close()


init_db()


# ---------------------------------------------------------------- request plumbing

PUBLIC_ENDPOINTS = {"login", "signup", "static"}


@app.before_request
def before_request():
    db.connect(reuse_if_open=True)

    # CSRF protection for every state-changing request.
    if request.method == "POST":
        sent = request.form.get("csrf_token", "")
        expected = session.get("csrf", "")
        if not expected or not secrets.compare_digest(sent, expected):
            abort(400, "Invalid or missing CSRF token.")

    g.user = None
    uid = session.get("user_id")
    if uid:
        g.user = User.get_or_none(User.id == uid)
        if g.user is None:
            session.clear()

    if request.endpoint not in PUBLIC_ENDPOINTS and g.user is None:
        if request.path.startswith("/api/"):
            return jsonify(error="login required"), 401
        return redirect(url_for("login"))

    if g.user and request.endpoint != "static":
        process_recurring(g.user.id)


@app.teardown_request
def teardown_request(exc):
    if not db.is_closed():
        db.close()


@app.after_request
def security_headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "same-origin"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "frame-ancestors 'none'; form-action 'self'")
    if request.endpoint != "static":
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.context_processor
def inject_globals():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)
    return dict(csrf_token=session["csrf"], current_user=g.get("user"))


@app.template_filter("money")
def money(cents, signed=False):
    cents = cents or 0
    sign = "-" if cents < 0 else ("+" if signed and cents > 0 else "")
    return f"{sign}€{abs(cents) / 100:,.2f}"


def admin_required(view):
    @wraps(view)
    def wrapped(*a, **kw):
        if not g.user or not g.user.is_admin:
            abort(403)
        return view(*a, **kw)
    return wrapped


# ---------------------------------------------------------------- auth

_failures = {}  # (ip, username) -> [timestamps]; simple in-memory login throttle
MAX_FAILS, WINDOW = 5, 300


def _throttled(key):
    now = time_mod.time()
    recent = [t for t in _failures.get(key, []) if now - t < WINDOW]
    _failures[key] = recent
    return len(recent) >= MAX_FAILS


@app.route("/login", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(url_for("home"))
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if not username or not password:
            flash("Username and password are required.")
            return render_template("auth.html", active_tab="login"), 400
        key = (request.remote_addr, username.lower())
        if _throttled(key):
            flash("Too many failed attempts. Try again in a few minutes.")
            return render_template("auth.html", active_tab="login"), 429
        user = User.get_or_none(User.name == username)
        valid = check_password_hash(user.password if user else DUMMY_HASH, password)
        if not user or not valid:
            _failures.setdefault(key, []).append(time_mod.time())
            flash("Invalid username or password.")
            return render_template("auth.html", active_tab="login"), 401
        _failures.pop(key, None)
        session.clear()
        session.permanent = request.form.get("remember") == "1"
        session["user_id"] = user.id
        return redirect(url_for("home"))
    return render_template("auth.html", active_tab="login")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if g.user:
        return redirect(url_for("home"))
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm", "")
        error = None
        if not username or not email or not password:
            error = "Username, email and password are required."
        elif not USERNAME_RE.match(username):
            error = "Username must be 3-32 characters: letters, numbers, . _ -"
        elif len(email) > 254 or not EMAIL_RE.match(email):
            error = "Enter a valid email address."
        elif len(password) < 8:
            error = "Password must be at least 8 characters."
        elif password != confirm:
            error = "Passwords don't match."
        elif not AllowedEmail.get_or_none(AllowedEmail.email == email):
            error = "This email hasn't been authorised. Ask an admin to add it."
        elif User.get_or_none(User.email == email):
            error = "An account already exists for this email."
        elif User.get_or_none(User.name == username):
            error = "That username is taken."
        if error:
            flash(error)
            return render_template("auth.html", active_tab="signup"), 400
        User.create(name=username, email=email, password=generate_password_hash(password))
        flash("Account created. You can sign in now.", "success")
        return redirect(url_for("login"))
    return render_template("auth.html", active_tab="signup")


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.cli.command("create-admin")
@click.argument("username")
@click.argument("email")
@click.password_option()
def create_admin(username, email, password):
    """Create an admin account (or promote an existing user)."""
    email = email.strip().lower()
    if not USERNAME_RE.match(username) or not EMAIL_RE.match(email):
        raise click.ClickException("Invalid username or email.")
    if len(password) < 8:
        raise click.ClickException("Password must be at least 8 characters.")
    db.connect(reuse_if_open=True)
    AllowedEmail.get_or_create(email=email)
    user = User.get_or_none(User.name == username)
    if user:
        user.is_admin = True
        user.email = user.email or email
        user.password = generate_password_hash(password)
        user.save()
        click.echo(f"Promoted {username} to admin.")
    else:
        User.create(name=username, email=email, is_admin=True,
                    password=generate_password_hash(password))
        click.echo(f"Created admin {username}.")
    db.close()


# ---------------------------------------------------------------- admin

@app.route("/admin", methods=["GET", "POST"])
@admin_required
def admin():
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        if len(email) > 254 or not EMAIL_RE.match(email):
            flash("Enter a valid email address.")
        elif AllowedEmail.get_or_none(AllowedEmail.email == email):
            flash("That email is already authorised.")
        else:
            AllowedEmail.create(email=email, added_by=g.user)
            flash(f"Authorised {email}.", "success")
        return redirect(url_for("admin"))
    registered = {u.email: u.name for u in User.select() if u.email}
    rows = [dict(id=a.id, email=a.email, added_at=a.added_at, user=registered.get(a.email))
            for a in AllowedEmail.select().order_by(AllowedEmail.added_at.desc())]
    return render_template("admin.html", rows=rows)


@app.post("/admin/emails/<int:email_id>/delete")
@admin_required
def admin_delete_email(email_id):
    entry = AllowedEmail.get_or_none(AllowedEmail.id == email_id)
    if entry:
        if User.get_or_none(User.email == entry.email):
            flash("That email already has an account; it can't be revoked here.")
        else:
            entry.delete_instance()
            flash(f"Removed {entry.email}.", "success")
    return redirect(url_for("admin"))


# ---------------------------------------------------------------- periods & stats

PERIODS = ("week", "month", "year")
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def period_range(period, today):
    if period == "week":
        start = datetime.combine(today - timedelta(days=today.weekday()), time.min)
        return start, start + timedelta(days=7)
    if period == "month":
        start = datetime(today.year, today.month, 1)
        end = datetime(today.year + (today.month == 12), today.month % 12 + 1, 1)
        return start, end
    return datetime(today.year, 1, 1), datetime(today.year + 1, 1, 1)


def previous_range(period, start):
    if period == "week":
        return start - timedelta(days=7), start
    if period == "month":
        prev_last_day = start - timedelta(days=1)
        return datetime(prev_last_day.year, prev_last_day.month, 1), start
    return datetime(start.year - 1, 1, 1), start


def bucket_labels(period, start):
    if period == "week":
        return DAYS
    if period == "month":
        return [str(d) for d in range(1, calendar.monthrange(start.year, start.month)[1] + 1)]
    return MONTHS


def bucket_index(period, start, dt):
    if period == "week":
        return (dt.date() - start.date()).days
    if period == "month":
        return dt.day - 1
    return dt.month - 1


def range_label(period, start, end):
    if period == "week":
        last = end - timedelta(days=1)
        return f"{start:%b} {start.day} – {last:%b} {last.day}, {last.year}"
    if period == "month":
        return f"{start:%B %Y}"
    return str(start.year)


def totals(user_id, start, end):
    q = (Transaction.select(Transaction.kind, fn.SUM(Transaction.amount_cents))
         .where(Transaction.user == user_id,
                Transaction.created_at >= start, Transaction.created_at < end)
         .group_by(Transaction.kind).tuples())
    t = {"income": 0, "expense": 0}
    for kind, total in q:
        t[kind] = int(total or 0)
    t["net"] = t["income"] - t["expense"]
    return t


def pct_change(cur, prev):
    if not prev:
        return None
    return round((cur - prev) / abs(prev) * 100, 1)


def series(user_id, period, start, end, n):
    inc, exp = [0] * n, [0] * n
    rows = Transaction.select().where(Transaction.user == user_id,
                                      Transaction.created_at >= start,
                                      Transaction.created_at < end)
    for t in rows:
        i = bucket_index(period, start, t.created_at)
        if 0 <= i < n:
            (inc if t.kind == "income" else exp)[i] += t.amount_cents
    return inc, exp


def build_stats(user_id, period, now=None):
    now = now or datetime.now()
    start, end = period_range(period, now.date())
    pstart, pend = previous_range(period, start)
    labels = bucket_labels(period, start)
    n = len(labels)
    inc, exp = series(user_id, period, start, end, n)
    pinc, pexp = series(user_id, period, pstart, pend, n)
    cur, prev = totals(user_id, start, end), totals(user_id, pstart, pend)
    cats = (Transaction.select(Transaction.category, fn.SUM(Transaction.amount_cents).alias("total"))
            .where(Transaction.user == user_id, Transaction.kind == "expense",
                   Transaction.created_at >= start, Transaction.created_at < end)
            .group_by(Transaction.category)
            .order_by(fn.SUM(Transaction.amount_cents).desc()).tuples())
    return dict(
        categories=[dict(name=c, cents=int(t)) for c, t in cats],
        period=period, labels=labels, now_index=bucket_index(period, start, now),
        income=inc, expense=exp, prev_income=pinc, prev_expense=pexp,
        label=range_label(period, start, end), prev_label=range_label(period, pstart, pend),
        totals=cur, prev_totals=prev,
        change={k: pct_change(cur[k], prev[k]) for k in ("income", "expense", "net")},
    )


# ---------------------------------------------------------------- money parsing

def parse_money(raw, allow_zero=False, allow_negative=False):
    """Parse '12,50', '1.234,56', '€ 1,234.56', '-20' into cents, or None if invalid."""
    raw = (raw or "").strip().replace("€", "").replace(" ", "").replace(" ", "")
    if not raw:
        return 0 if allow_zero else None
    if "," in raw and "." in raw:
        # whichever separator comes last is the decimal one
        raw = raw.replace(".", "").replace(",", ".") if raw.rfind(",") > raw.rfind(".") else raw.replace(",", "")
    elif "," in raw:
        raw = raw.replace(",", ".")
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    if not value.is_finite():
        return None
    cents = int((value * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))
    if abs(cents) > MAX_CENTS or (cents < 0 and not allow_negative) or (cents == 0 and not allow_zero):
        return None
    return cents


def parse_amount(raw):
    return parse_money(raw)


# ---------------------------------------------------------------- categories

def user_categories(user_id):
    return list(Category.select().where(Category.user == user_id).order_by(Category.name))


def valid_category(user_id, name):
    if name in CATEGORIES:
        return name
    c = Category.get_or_none(Category.user == user_id, Category.name == name)
    return c.name if c else "Other"


@app.post("/categories")
def add_category():
    name = " ".join(request.form.get("name", "").split())[:32]
    if not name:
        return jsonify(error="Type a name for the category."), 400
    lowered = name.lower()
    if any(c.lower() == lowered for c in CATEGORIES) or \
            any(c.name.lower() == lowered for c in user_categories(g.user.id)):
        return jsonify(error="That category already exists."), 400
    if Category.select().where(Category.user == g.user.id).count() >= 50:
        return jsonify(error="You can have up to 50 of your own categories."), 400
    c = Category.create(user=g.user, name=name)
    return jsonify(id=c.id, name=c.name)


@app.post("/categories/<int:cat_id>/delete")
def delete_category(cat_id):
    c = Category.get_or_none(Category.id == cat_id, Category.user == g.user.id)
    if not c:
        return jsonify(error="Not found."), 404
    c.delete_instance()  # existing entries keep their category text
    return jsonify(ok=True)


# ---------------------------------------------------------------- recurring payments

def add_months(d, months, anchor_day):
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(anchor_day, calendar.monthrange(y, m)[1]))


def next_occurrence(frequency, d, anchor_day):
    if frequency == "weekly":
        return d + timedelta(days=7)
    if frequency == "biweekly":
        return d + timedelta(days=14)
    if frequency == "monthly":
        return add_months(d, 1, anchor_day)
    if frequency == "yearly":
        return add_months(d, 12, anchor_day)
    return None  # once


def occurrences(r, until):
    """Dates this recurring item will still be booked on, up to and including `until`."""
    d, out = r.next_date, []
    while r.active and d and d <= until and (r.end_date is None or d <= r.end_date) and len(out) < 400:
        out.append(d)
        d = next_occurrence(r.frequency, d, r.anchor_day)
    return out


def process_recurring(user_id, today=None):
    """Book every recurring item that has come due as a real transaction."""
    today = today or date.today()
    due = list(Recurring.select().where(Recurring.user == user_id, Recurring.active == True,
                                        Recurring.next_date <= today))
    for r in due:
        d = r.next_date
        with db.atomic():
            for _ in range(1000):
                if d > today:
                    break
                if r.end_date and d > r.end_date:
                    Recurring.update(active=False).where(Recurring.id == r.id).execute()
                    break
                nxt = next_occurrence(r.frequency, d, r.anchor_day)
                done = nxt is None or (r.end_date is not None and nxt > r.end_date)
                # Claim this occurrence atomically so two parallel requests can't book it twice.
                claimed = (Recurring.update(next_date=nxt or d, active=not done)
                           .where(Recurring.id == r.id, Recurring.next_date == d, Recurring.active == True)
                           .execute())
                if claimed != 1:
                    break
                booked = datetime.combine(d, time(0, 0))
                if Transaction.select().where(Transaction.recurring == r.id,
                                              Transaction.created_at == booked).exists():
                    # Already booked (e.g. it was edited back to a date it already ran on).
                    if done:
                        break
                    d = nxt
                    continue
                Transaction.create(user=user_id, kind=r.kind, amount_cents=r.amount_cents,
                                   description=r.description, category=r.category, method=r.method,
                                   recurring=r.id, created_at=booked)
                if done:
                    break
                d = nxt


def monthly_equivalent(r):
    if r.frequency not in PER_MONTH:
        return 0
    return int((r.amount_cents * PER_MONTH[r.frequency]).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def recurring_form_values(form, user_id):
    """Validate the recurring form. Returns (values, error)."""
    kind = form.get("kind")
    cents = parse_amount(form.get("amount"))
    description = " ".join(form.get("description", "").split())[:80]
    frequency = form.get("frequency")
    method = form.get("method", "card")
    try:
        next_date = date.fromisoformat(form.get("next_date", ""))
    except ValueError:
        next_date = None
    end_raw = form.get("end_date", "").strip()
    try:
        end_date = date.fromisoformat(end_raw) if end_raw else None
    except ValueError:
        return None, "Enter a valid end date."
    if kind not in ("income", "expense"):
        return None, "Choose whether this is a payment or income."
    if cents is None:
        return None, "Enter a valid amount greater than zero."
    if not description:
        return None, "Give it a name, e.g. Netflix or Salary."
    if frequency not in FREQUENCIES:
        return None, "Choose how often it repeats."
    if method not in METHODS:
        method = "card"
    if next_date is None:
        return None, "Choose the next date."
    if next_date < date.today():
        return None, "The next date can't be in the past."
    if next_date > date.today() + timedelta(days=3660):
        return None, "The next date is too far away."
    if end_date and end_date < next_date:
        return None, "The end date must be after the next date."
    return dict(kind=kind, amount_cents=cents, description=description, frequency=frequency,
                method=method, next_date=next_date, anchor_day=next_date.day, end_date=end_date,
                category=valid_category(user_id, form.get("category", "Other"))), None


def recurring_page(edit=None, status=200):
    items = list(Recurring.select().where(Recurring.user == g.user.id)
                 .order_by(Recurring.active.desc(), Recurring.next_date))
    monthly_in = sum(monthly_equivalent(r) for r in items if r.active and r.kind == "income")
    monthly_out = sum(monthly_equivalent(r) for r in items if r.active and r.kind == "expense")
    return render_template("recurring.html", items=items, edit=edit, frequencies=FREQUENCIES,
                           categories=CATEGORIES, custom_categories=user_categories(g.user.id),
                           monthly_in=monthly_in, monthly_out=monthly_out,
                           monthly_equivalent=monthly_equivalent, today=date.today()), status


@app.get("/recurring")
def recurring():
    return recurring_page()


@app.get("/recurring/<int:rid>/edit")
def recurring_edit(rid):
    r = Recurring.get_or_none(Recurring.id == rid, Recurring.user == g.user.id)
    if not r:
        abort(404)
    return recurring_page(edit=r)


@app.post("/recurring")
@app.post("/recurring/<int:rid>")
def recurring_save(rid=None):
    r = None
    if rid is not None:
        r = Recurring.get_or_none(Recurring.id == rid, Recurring.user == g.user.id)
        if not r:
            abort(404)
    values, error = recurring_form_values(request.form, g.user.id)
    if error:
        flash(error)
        return recurring_page(edit=r, status=400)
    if r:
        for k, v in values.items():
            setattr(r, k, v)
        r.active = True
        r.save()
        flash(f"Updated {r.description}.", "success")
    else:
        r = Recurring.create(user=g.user, **values)
        flash(f"Added {r.description}.", "success")
    process_recurring(g.user.id)  # books it right away if it's due today
    return redirect(url_for("recurring"))


@app.post("/recurring/<int:rid>/toggle")
def recurring_toggle(rid):
    r = Recurring.get_or_none(Recurring.id == rid, Recurring.user == g.user.id)
    if r:
        if not r.active and r.next_date < date.today():
            # Resuming after a pause: skip the dates that passed while paused.
            d = r.next_date
            while d and d < date.today():
                d = next_occurrence(r.frequency, d, r.anchor_day)
            if d is None:
                flash("That one-off date has passed. Edit it to pick a new date.")
                return redirect(url_for("recurring"))
            r.next_date = d
        r.active = not r.active
        r.save()
        flash(("Resumed " if r.active else "Paused ") + r.description + ".", "success")
        process_recurring(g.user.id)
    return redirect(url_for("recurring"))


@app.post("/recurring/<int:rid>/delete")
def recurring_delete(rid):
    r = Recurring.get_or_none(Recurring.id == rid, Recurring.user == g.user.id)
    if r:
        r.delete_instance()  # already-booked entries stay
        flash(f"Removed {r.description}.", "success")
    return redirect(url_for("recurring"))


# ---------------------------------------------------------------- balance

def latest_snapshot(user_id):
    return (BalanceSnapshot.select().where(BalanceSnapshot.user == user_id)
            .order_by(BalanceSnapshot.set_at.desc(), BalanceSnapshot.id.desc()).first())


def current_balance(user_id):
    """Last counted balance plus everything booked since. None if never set."""
    snap = latest_snapshot(user_id)
    if not snap:
        return None
    cash, card = snap.cash_cents, snap.card_cents
    q = (Transaction.select(Transaction.kind, Transaction.method, fn.SUM(Transaction.amount_cents))
         .where(Transaction.user == user_id, Transaction.created_at > snap.set_at)
         .group_by(Transaction.kind, Transaction.method).tuples())
    for kind, method, total in q:
        delta = int(total or 0) * (1 if kind == "income" else -1)
        if method == "cash":
            cash += delta
        else:
            card += delta
    return dict(cash=cash, card=card, total=cash + card, set_at=snap.set_at)


@app.route("/balance", methods=["GET", "POST"])
def balance():
    if request.method == "POST":
        card = parse_money(request.form.get("card"), allow_zero=True, allow_negative=True)
        typed = parse_money(request.form.get("cash_typed"), allow_zero=True)
        counts = {}
        bad = card is None or typed is None
        for cents in NOTES + COINS:
            raw = request.form.get(f"n_{cents}", "0").strip() or "0"
            if not raw.isdigit() or int(raw) > 100000:
                bad = True
                break
            if int(raw):
                counts[str(cents)] = int(raw)
        if bad:
            flash("Check the amounts: card can be any amount, cash can't be negative.")
            return redirect(url_for("balance"))
        cash = typed + sum(int(k) * n for k, n in counts.items())
        if cash > MAX_CENTS:
            flash("That's more cash than this app can count.")
            return redirect(url_for("balance"))
        BalanceSnapshot.create(user=g.user, card_cents=card, cash_cents=cash,
                               cash_detail=json.dumps({"counts": counts, "typed": typed}))
        flash(f"Balance set to {money(card + cash)}.", "success")
        return redirect(url_for("home"))
    history = list(BalanceSnapshot.select().where(BalanceSnapshot.user == g.user.id)
                   .order_by(BalanceSnapshot.set_at.desc()).limit(8))
    return render_template("balance.html", tracked=current_balance(g.user.id), history=history,
                           notes=NOTES, coins=COINS)


# ---------------------------------------------------------------- forecast

def month_end(d, months_ahead=0):
    first = add_months(date(d.year, d.month, 1), months_ahead, 1)
    return date(first.year, first.month, calendar.monthrange(first.year, first.month)[1])


FORECAST_RANGES = {1: "Next month", 6: "6 months", 12: "1 year"}  # months ahead -> label


def build_forecast(user_id, now=None, months=1):
    now = now or datetime.now()
    today = now.date()
    months = months if months in FORECAST_RANGES else 1
    end_this, end_next = month_end(today), month_end(today, 1)
    horizon = month_end(today, months)
    bal = current_balance(user_id)
    start = bal["total"] if bal else 0

    items = list(Recurring.select().where(Recurring.user == user_id, Recurring.active == True))
    events = []
    for r in items:
        for d in occurrences(r, horizon):
            events.append(dict(date=d.isoformat(), description=r.description, category=r.category,
                               kind=r.kind, method=r.method, frequency=FREQUENCIES[r.frequency],
                               cents=r.amount_cents if r.kind == "income" else -r.amount_cents))
    events.sort(key=lambda e: (e["date"], -e["cents"]))

    # Day-by-day balance with only fixed (recurring) money moving.
    labels, fixed = [], []
    by_day = {}
    for e in events:
        by_day[e["date"]] = by_day.get(e["date"], 0) + e["cents"]
    running = start
    d = today
    while d <= horizon:
        running += by_day.get(d.isoformat(), 0)
        labels.append(d.isoformat())
        fixed.append(running)
        d += timedelta(days=1)
    running = start
    for e in events:
        running += e["cents"]
        e["balance_after"] = running

    monthly_in = sum(monthly_equivalent(r) for r in items if r.kind == "income")
    monthly_out = sum(monthly_equivalent(r) for r in items if r.kind == "expense")
    idx_this = (end_this - today).days
    return dict(
        has_balance=bal is not None, start=start,
        cash=bal["cash"] if bal else 0, card=bal["card"] if bal else 0,
        set_at=bal["set_at"].isoformat() if bal else None,
        labels=labels, fixed=fixed, events=events,
        end_this=dict(date=end_this.isoformat(), index=idx_this, label=f"{end_this:%B}"),
        end_next=dict(date=end_next.isoformat(), index=(end_next - today).days, label=f"{end_next:%B}"),
        horizon=dict(date=horizon.isoformat(), index=len(labels) - 1, months=months,
                     label=f"{horizon:%B}" + (f" {horizon.year}" if horizon.year != today.year else "")),
        monthly=dict(income=monthly_in, expense=monthly_out, net=monthly_in - monthly_out),
    )


@app.get("/forecast")
def forecast():
    months = request.args.get("months", "1")
    months = int(months) if months.isdigit() else 1
    return render_template("forecast.html", data=build_forecast(g.user.id, months=months),
                           ranges=FORECAST_RANGES, today=date.today())


@app.get("/api/forecast")
def api_forecast():
    months = request.args.get("months", "1")
    return jsonify(build_forecast(g.user.id, months=int(months) if months.isdigit() else 1))


# ---------------------------------------------------------------- dashboard

@app.route("/")
def home():
    now = datetime.now()
    cards = []
    for p in PERIODS:
        start, end = period_range(p, now.date())
        pstart, pend = previous_range(p, start)
        cur, prev = totals(g.user.id, start, end), totals(g.user.id, pstart, pend)
        spent_pct = round(cur["expense"] / cur["income"] * 100) if cur["income"] else None
        cards.append(dict(period=p, label=range_label(p, start, end), totals=cur,
                          spent_pct=spent_pct,
                          expense_change=pct_change(cur["expense"], prev["expense"]),
                          income_change=pct_change(cur["income"], prev["income"])))
    recent = list(Transaction.select().where(Transaction.user == g.user.id)
                  .order_by(Transaction.created_at.desc(), Transaction.id.desc()).limit(25))
    fc = build_forecast(g.user.id, now)
    upcoming = [e for e in fc["events"] if e["date"] <= (now.date() + timedelta(days=14)).isoformat()][:5]
    return render_template("dashboard.html", cards=cards, recent=recent, timedelta=timedelta,
                           categories=CATEGORIES, custom_categories=user_categories(g.user.id),
                           initial=build_stats(g.user.id, "month", now), forecast=fc,
                           balance=current_balance(g.user.id), upcoming=upcoming,
                           today=now.date(), now=now, new_tx=session.pop("new_tx", None))


@app.get("/api/stats")
def api_stats():
    period = request.args.get("period", "month")
    if period not in PERIODS:
        return jsonify(error="bad period"), 400
    return jsonify(build_stats(g.user.id, period))


def parse_when(raw):
    """The date/time picked in the add form. Blank or 'right now' -> the current moment."""
    now = datetime.now()
    raw = (raw or "").strip()
    if not raw:
        return now, None
    try:
        when = datetime.fromisoformat(raw)
    except ValueError:
        return None, "Enter a valid date and time."
    if when.tzinfo is not None:
        return None, "Enter a valid date and time."
    if when > now + timedelta(minutes=5):
        return None, "The date can't be in the future. Plan future payments under Recurring (choose Once)."
    if when < now - timedelta(days=3660):
        return None, "That date is too far in the past."
    if abs((now - when).total_seconds()) < 90:
        return now, None  # the untouched "now" value: keep the exact current time
    return when, None


@app.post("/transactions")
def add_transaction():
    kind = request.form.get("kind")
    cents = parse_amount(request.form.get("amount"))
    description = request.form.get("description", "").strip()[:120]
    method = request.form.get("method", "card")
    when, when_error = parse_when(request.form.get("when", ""))
    if kind not in ("income", "expense"):
        flash("Choose whether this is spending or an earning.")
    elif cents is None:
        flash("Enter a valid amount greater than zero.")
    elif when_error:
        flash(when_error)
    else:
        tx = Transaction.create(user=g.user, kind=kind, amount_cents=cents, description=description,
                                created_at=when,
                                method=method if method in METHODS else "card",
                                category=valid_category(g.user.id, request.form.get("category", "Other")))
        session["new_tx"] = tx.id  # highlighted once on the next page load
        flash("Earning added." if kind == "income" else "Spending added.", "success")
    return redirect(url_for("home"))


@app.post("/transactions/<int:tx_id>/delete")
def delete_transaction(tx_id):
    tx = Transaction.get_or_none(Transaction.id == tx_id, Transaction.user == g.user.id)
    if tx:
        tx.delete_instance()
        flash("Entry deleted.", "success")
    return redirect(url_for("home"))


@app.template_filter("month_name")
def month_name(d):
    if isinstance(d, str):
        d = date.fromisoformat(d)
    return f"{d:%B %Y}"


@app.template_filter("rel_date")
def rel_date(d):
    if isinstance(d, str):
        d = date.fromisoformat(d)
    diff = (d - date.today()).days
    if diff == 0:
        return "Today"
    if diff == 1:
        return "Tomorrow"
    if 1 < diff < 7:
        return f"In {diff} days"
    return f"{d:%a} {d.day} {d:%b}" + (f" {d.year}" if d.year != date.today().year else "")


if __name__ == "__main__":
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1")
