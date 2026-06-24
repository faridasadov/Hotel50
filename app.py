#!/usr/bin/env python3
import json
import os
import hashlib
import hmac
import csv
import io
import base64
import sqlite3
import shutil
import secrets
import time
import threading
from datetime import date, datetime, timedelta
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import quote, urlparse, parse_qs
from html import escape as html_escape

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DB_PATH = ROOT / "hotel50.db"
BACKUP_DIR = ROOT / "backups"
ADMIN_USER = os.environ.get("ADMIN_USER", "admin")
ADMIN_PASSWORD_HASH = os.environ.get(
    "ADMIN_PASSWORD_HASH",
    "scrypt:hotel502026:9de66a82e7d4de895b4b9afb527ea963d023de5a645f1a55f52be3ad9be76c34f5b29faf2a5a28f7a3d160ebb12c3561ce7b03d76dff6606bba50ec82bb4bc17",
)
COOKIE_NAME = "hotel50_admin"
LOGIN_WINDOW_SECONDS = 15 * 60
LOGIN_MAX_ATTEMPTS = 8
SESSION_DAYS = 1
LOGIN_ATTEMPTS: dict = {}
ROLES = {"Admin", "Reception", "Accounting"}
OPS_ROLES = {"Admin", "Reception"}
MONEY_ROLES = {"Admin", "Accounting"}
CHECKIN_HOUR = 14
CHECKOUT_HOUR = 12
MAX_DOC_SIZE = 10 * 1024 * 1024  # 10 MB (base64 string length limit)


# ─────────────────────── DB ───────────────────────

def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db():
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS rooms (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              number TEXT NOT NULL UNIQUE,
              floor INTEGER NOT NULL DEFAULT 1,
              room_type TEXT NOT NULL DEFAULT 'Standard',
              capacity INTEGER NOT NULL DEFAULT 1,
              nightly_rate REAL NOT NULL DEFAULT 0,
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS guests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              full_name TEXT NOT NULL,
              phone TEXT DEFAULT '',
              document_no TEXT DEFAULT '',
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS bookings (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              guest_id INTEGER NOT NULL,
              room_id INTEGER NOT NULL,
              check_in TEXT NOT NULL,
              check_out TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'Reserved',
              people_count INTEGER NOT NULL DEFAULT 1,
              total_amount REAL NOT NULL DEFAULT 0,
              late_fee REAL NOT NULL DEFAULT 0,
              actual_check_out_at TEXT DEFAULT '',
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (guest_id) REFERENCES guests(id),
              FOREIGN KEY (room_id) REFERENCES rooms(id)
            );

            CREATE TABLE IF NOT EXISTS payments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              booking_id INTEGER NOT NULL,
              amount REAL NOT NULL,
              method TEXT NOT NULL DEFAULT 'Cash',
              paid_at TEXT NOT NULL DEFAULT CURRENT_DATE,
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (booking_id) REFERENCES bookings(id)
            );

            CREATE TABLE IF NOT EXISTS expenses (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              category TEXT NOT NULL,
              amount REAL NOT NULL,
              spent_at TEXT NOT NULL DEFAULT CURRENT_DATE,
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS guest_documents (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              guest_id INTEGER NOT NULL,
              title TEXT NOT NULL,
              file_name TEXT NOT NULL,
              content_type TEXT DEFAULT 'application/octet-stream',
              data TEXT NOT NULL,
              storage_type TEXT NOT NULL DEFAULT 'text',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (guest_id) REFERENCES guests(id)
            );

            CREATE TABLE IF NOT EXISTS booking_requests (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              full_name TEXT NOT NULL,
              phone TEXT DEFAULT '',
              check_in TEXT DEFAULT '',
              check_out TEXT DEFAULT '',
              people_count INTEGER NOT NULL DEFAULT 1,
              note TEXT DEFAULT '',
              status TEXT NOT NULL DEFAULT 'Yeni',
              handled_by TEXT DEFAULT '',
              handled_at TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS room_orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              room_id INTEGER NOT NULL,
              booking_id INTEGER,
              category TEXT NOT NULL DEFAULT 'Yemək',
              description TEXT NOT NULL DEFAULT '',
              amount REAL NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'Yeni',
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (room_id) REFERENCES rooms(id),
              FOREIGN KEY (booking_id) REFERENCES bookings(id)
            );

            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              full_name TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'Reception',
              password_hash TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL,
              action TEXT NOT NULL,
              entity TEXT NOT NULL,
              entity_id TEXT DEFAULT '',
              note TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              expires_at TEXT NOT NULL,
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS room_categories (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL UNIQUE,
              description TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            """
        )

        # Migrate older schemas
        for sql in [
            "ALTER TABLE rooms ADD COLUMN cleaning_status TEXT DEFAULT 'Təmiz'",
            "ALTER TABLE bookings ADD COLUMN late_fee REAL NOT NULL DEFAULT 0",
            "ALTER TABLE bookings ADD COLUMN actual_check_out_at TEXT DEFAULT ''",
            "ALTER TABLE guest_documents ADD COLUMN storage_type TEXT NOT NULL DEFAULT 'text'",
            "ALTER TABLE booking_requests ADD COLUMN handled_by TEXT DEFAULT ''",
            "ALTER TABLE booking_requests ADD COLUMN handled_at TEXT DEFAULT ''",
            "ALTER TABLE booking_requests ADD COLUMN room_category TEXT DEFAULT ''",
            "ALTER TABLE room_categories ADD COLUMN base_price REAL DEFAULT 0",
            "ALTER TABLE room_categories ADD COLUMN amenities TEXT DEFAULT '[]'",
        ]:
            try:
                db.execute(sql)
            except sqlite3.OperationalError:
                pass

        db.execute("DROP TABLE IF EXISTS hotels")

        cat_count = db.execute("SELECT COUNT(*) AS c FROM room_categories").fetchone()["c"]
        if cat_count == 0:
            for name, desc, price, amenities in [
                ("Standard", "Standart otaq",              45,  '["wifi","bath","tv","ac"]'),
                ("Superior", "Təkmilləşdirilmiş otaq",     65,  '["wifi","bath","tv","ac","minibar"]'),
                ("Deluxe",   "Deluxe otaq",                85,  '["wifi","bath","tv","ac","minibar","cityview"]'),
                ("Suite",    "Lüks süit",                  120, '["wifi","bath","tv","ac","minibar","cityview","breakfast","balcony"]'),
                ("Family",   "Ailə otağı",                 90,  '["wifi","bath","tv","ac","breakfast","roomservice"]'),
            ]:
                db.execute(
                    "INSERT OR IGNORE INTO room_categories (name, description, base_price, amenities) VALUES (?, ?, ?, ?)",
                    (name, desc, price, amenities),
                )
        else:
            # One-time: seed amenities/prices for existing categories that are still at defaults
            defaults = {
                "Standard": (45,  '["wifi","bath","tv","ac"]'),
                "Superior": (65,  '["wifi","bath","tv","ac","minibar"]'),
                "Deluxe":   (85,  '["wifi","bath","tv","ac","minibar","cityview"]'),
                "Suite":    (120, '["wifi","bath","tv","ac","minibar","cityview","breakfast","balcony"]'),
                "Family":   (90,  '["wifi","bath","tv","ac","breakfast","roomservice"]'),
            }
            for cat_name, (price, amenities) in defaults.items():
                db.execute(
                    "UPDATE room_categories SET base_price = ?, amenities = ? WHERE name = ? AND (amenities = '[]' OR amenities IS NULL)",
                    (price, amenities, cat_name),
                )

        # Indexes for performance
        for idx_sql in [
            "CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)",
            "CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(check_in, check_out)",
            "CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)",
            "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
            "CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at)",
            "CREATE INDEX IF NOT EXISTS idx_guests_name ON guests(full_name)",
            "CREATE INDEX IF NOT EXISTS idx_room_orders_room ON room_orders(room_id)",
            "CREATE INDEX IF NOT EXISTS idx_room_orders_status ON room_orders(status)",
        ]:
            try:
                db.execute(idx_sql)
            except sqlite3.OperationalError:
                pass

        user_count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        if user_count == 0:
            for uname, fname, role, pw_hash in [
                (ADMIN_USER, "System Admin", "Admin", ADMIN_PASSWORD_HASH),
                ("reception", "Resepsion", "Reception", hash_password("reception123")),
                ("accounting", "Mühasibat", "Accounting", hash_password("accounting123")),
            ]:
                db.execute(
                    "INSERT OR IGNORE INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                    (uname, fname, role, pw_hash),
                )

        count = db.execute("SELECT COUNT(*) AS c FROM rooms").fetchone()["c"]
        if count == 0:
            rooms = []
            for floor in range(1, 6):
                for idx in range(1, 6):
                    number = f"{floor}{idx:02d}"
                    rooms.append((number, floor, "Standard", 2, 45, ""))
            db.executemany(
                "INSERT INTO rooms (number, floor, room_type, capacity, nightly_rate, note) VALUES (?, ?, ?, ?, ?, ?)",
                rooms,
            )


def rows(sql, params=()):
    with connect() as db:
        return [dict(r) for r in db.execute(sql, params).fetchall()]


def row(sql, params=()):
    with connect() as db:
        item = db.execute(sql, params).fetchone()
        return dict(item) if item else None


def execute(sql, params=()):
    with connect() as db:
        cur = db.execute(sql, params)
        db.commit()
        return cur.lastrowid


# ─────────────────────── Sessions ───────────────────────

def create_session(user_id: int) -> str:
    token = secrets.token_hex(32)
    expires_at = (datetime.now() + timedelta(days=SESSION_DAYS)).isoformat()
    execute(
        "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, user_id, expires_at),
    )
    return token


def get_session_user(token: str):
    if not token:
        return None
    return row(
        """
        SELECT u.* FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND s.expires_at > ? AND u.active = 1
        """,
        (token, datetime.now().isoformat()),
    )


def delete_session(token: str):
    execute("DELETE FROM sessions WHERE token = ?", (token,))


def cleanup_expired():
    """Remove expired sessions and old login attempt records."""
    try:
        execute("DELETE FROM sessions WHERE expires_at <= ?", (datetime.now().isoformat(),))
        now = time.time()
        for key in list(LOGIN_ATTEMPTS):
            if LOGIN_ATTEMPTS[key].get("reset_at", 0) <= now:
                LOGIN_ATTEMPTS.pop(key, None)
    except Exception:
        pass


# ─────────────────────── Helpers ───────────────────────

def json_body(handler):
    length = int(handler.headers.get("Content-Length", "0") or "0")
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def money(value):
    try:
        return round(float(value), 2)
    except (TypeError, ValueError):
        return 0


def integer(value, fallback=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def parse_cookies(header):
    cookies = {}
    for part in str(header or "").split(";"):
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        cookies[key.strip()] = value.strip()
    return cookies


def hash_password(password: str) -> str:
    salt = secrets.token_hex(8)
    hashed = hashlib.scrypt(
        str(password or "").encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384, r=8, p=1, dklen=64,
    ).hex()
    return f"scrypt:{salt}:{hashed}"


def verify_encoded_password(password, encoded_hash):
    try:
        scheme, salt, expected = str(encoded_hash or "").split(":", 2)
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(
            str(password or "").encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384, r=8, p=1, dklen=64,
        ).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def validate_dates(check_in: str, check_out: str):
    try:
        ci = datetime.strptime(check_in, "%Y-%m-%d").date()
        co = datetime.strptime(check_out, "%Y-%m-%d").date()
        if co <= ci:
            return False, "Çıxış tarixi giriş tarixindən sonra olmalıdır"
        return True, ""
    except ValueError:
        return False, "Tarix formatı düzgün deyil (YYYY-MM-DD)"


def current_local_time():
    return datetime.now()


def calculate_late_fee(booking_item, checkout_at=None):
    checkout_at = checkout_at or current_local_time()
    due_at = datetime.strptime(str(booking_item["check_out"]), "%Y-%m-%d").replace(
        hour=CHECKOUT_HOUR, minute=0, second=0, microsecond=0
    )
    if checkout_at <= due_at:
        return 0
    late_seconds = (checkout_at - due_at).total_seconds()
    late_hours = int((late_seconds + 3599) // 3600)
    hourly_rate = money(booking_item.get("room_rate", 0)) / 24
    return round(hourly_rate * late_hours, 2)


def login_key(handler):
    return handler.client_address[0] if handler.client_address else "unknown"


def login_limited(handler):
    now = time.time()
    key = login_key(handler)
    entry = LOGIN_ATTEMPTS.get(key, {"count": 0, "reset_at": now + LOGIN_WINDOW_SECONDS})
    if entry["reset_at"] <= now:
        LOGIN_ATTEMPTS[key] = {"count": 0, "reset_at": now + LOGIN_WINDOW_SECONDS}
        return False
    return entry["count"] >= LOGIN_MAX_ATTEMPTS


def record_login_failure(handler):
    now = time.time()
    key = login_key(handler)
    entry = LOGIN_ATTEMPTS.get(key, {"count": 0, "reset_at": now + LOGIN_WINDOW_SECONDS})
    entry["count"] += 1
    LOGIN_ATTEMPTS[key] = entry


def clear_login_failures(handler):
    LOGIN_ATTEMPTS.pop(login_key(handler), None)


def public_user(user):
    if not user:
        return None
    return {
        "id": user["id"],
        "username": user["username"],
        "full_name": user["full_name"],
        "role": user["role"],
        "active": user["active"],
        "created_at": user["created_at"],
    }


def audit(username, action, entity, entity_id="", note=""):
    execute(
        "INSERT INTO audit_logs (username, action, entity, entity_id, note) VALUES (?, ?, ?, ?, ?)",
        (username or "system", action, entity, str(entity_id or ""), str(note or "")),
    )


def days_between(start, end):
    try:
        s = datetime.strptime(start, "%Y-%m-%d").date()
        e = datetime.strptime(end, "%Y-%m-%d").date()
        return max((e - s).days, 1)
    except Exception:
        return 1


def has_capacity(room_id, check_in, check_out, people_count, exclude_booking_id=None):
    room = row("SELECT capacity FROM rooms WHERE id = ?", (room_id,))
    if not room:
        return False, "Otaq tapılmadı"
    params = [room_id, check_out, check_in]
    extra = ""
    if exclude_booking_id:
        extra = " AND id <> ?"
        params.append(exclude_booking_id)
    existing = row(
        f"""
        SELECT COALESCE(SUM(people_count), 0) AS people
        FROM bookings
        WHERE room_id = ?
          AND status IN ('Reserved', 'CheckedIn')
          AND check_in < ?
          AND check_out > ?
          {extra}
        """,
        tuple(params),
    )
    used = integer(existing["people"] if existing else 0)
    if used + integer(people_count, 1) > integer(room["capacity"], 1):
        return False, "Bu tarix aralığında otaqda kifayət qədər boş yer yoxdur"
    return True, ""


def room_rate(room_id):
    room_item = row("SELECT nightly_rate FROM rooms WHERE id = ?", (integer(room_id),))
    if not room_item:
        raise ValueError("Otaq tapılmadı")
    return money(room_item["nightly_rate"])


def booking_room_total(room_id, check_in, check_out):
    return round(room_rate(room_id) * days_between(check_in, check_out), 2)


def booking_service_orders(booking_id):
    return rows(
        """
        SELECT category, description, amount, created_at
        FROM room_orders
        WHERE booking_id = ? AND status = 'Çatdırıldı'
        ORDER BY created_at ASC
        """,
        (integer(booking_id),),
    )


def booking_financials(booking_id):
    item = row(
        """
        SELECT b.id, b.check_in, b.check_out, b.status, b.note, b.total_amount,
               COALESCE(b.late_fee, 0) AS late_fee,
               g.full_name AS guest_name, g.phone AS guest_phone,
               r.number AS room_number,
               COALESCE(ro.room_order_amount, 0) AS room_order_amount,
               COALESCE(p.total_paid, 0) AS total_paid
        FROM bookings b
        JOIN guests g ON g.id = b.guest_id
        JOIN rooms r ON r.id = b.room_id
        LEFT JOIN (
          SELECT booking_id, SUM(amount) AS room_order_amount
          FROM room_orders
          WHERE booking_id IS NOT NULL AND status = 'Çatdırıldı'
          GROUP BY booking_id
        ) ro ON ro.booking_id = b.id
        LEFT JOIN (
          SELECT booking_id, SUM(amount) AS total_paid
          FROM payments
          GROUP BY booking_id
        ) p ON p.booking_id = b.id
        WHERE b.id = ?
        """,
        (integer(booking_id),),
    )
    if not item:
        return None
    item["grand_total"] = round(money(item["total_amount"]) + money(item["room_order_amount"]) + money(item["late_fee"]), 2)
    item["balance"] = round(item["grand_total"] - money(item["total_paid"]), 2)
    item["service_orders"] = booking_service_orders(booking_id)
    return item


# ─────────────────────── Queries ───────────────────────

def booking_select(where="", params=()):
    sql = f"""
      SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone,
             r.number AS room_number, r.capacity AS room_capacity,
             r.nightly_rate AS room_rate,
             COALESCE(ro.room_order_amount, 0) AS room_order_amount,
             COALESCE(p.paid_amount, 0) AS paid_amount,
             b.total_amount + COALESCE(ro.room_order_amount, 0) + COALESCE(b.late_fee, 0) - COALESCE(p.paid_amount, 0) AS balance
      FROM bookings b
      JOIN guests g ON g.id = b.guest_id
      JOIN rooms r ON r.id = b.room_id
      LEFT JOIN (
        SELECT booking_id, SUM(amount) AS room_order_amount
        FROM room_orders
        WHERE booking_id IS NOT NULL AND status = 'Çatdırıldı'
        GROUP BY booking_id
      ) ro ON ro.booking_id = b.id
      LEFT JOIN (
        SELECT booking_id, SUM(amount) AS paid_amount
        FROM payments
        GROUP BY booking_id
      ) p ON p.booking_id = b.id
      {where}
      ORDER BY b.created_at DESC
    """
    return rows(sql, params)


def room_list():
    return rows(
        """
        SELECT r.*,
          COALESCE(SUM(CASE WHEN b.status = 'CheckedIn' THEN b.people_count ELSE 0 END), 0) AS occupied,
          r.capacity - COALESCE(SUM(CASE WHEN b.status = 'CheckedIn' THEN b.people_count ELSE 0 END), 0) AS free_beds
        FROM rooms r
        LEFT JOIN bookings b ON b.room_id = r.id
        GROUP BY r.id
        ORDER BY r.floor, r.number
        """
    )


def parse_categories(cats):
    for c in cats:
        try:
            c["amenities"] = json.loads(c.get("amenities") or "[]")
        except (json.JSONDecodeError, TypeError):
            c["amenities"] = []
    return cats


def document_payload(data, storage_type):
    if storage_type == "base64":
        return base64.b64decode(str(data or "").encode("ascii"))
    return str(data or "").encode("utf-8")


def debtors():
    return rows(
        """
        SELECT * FROM (
          SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone,
                 r.number AS room_number,
                 COALESCE(ro.room_order_amount, 0) AS room_order_amount,
                 COALESCE(p.paid_amount, 0) AS paid_amount,
                 b.total_amount + COALESCE(ro.room_order_amount, 0) + COALESCE(b.late_fee, 0) - COALESCE(p.paid_amount, 0) AS balance
          FROM bookings b
          JOIN guests g ON g.id = b.guest_id
          JOIN rooms r ON r.id = b.room_id
          LEFT JOIN (
            SELECT booking_id, SUM(amount) AS room_order_amount
            FROM room_orders
            WHERE booking_id IS NOT NULL AND status = 'Çatdırıldı'
            GROUP BY booking_id
          ) ro ON ro.booking_id = b.id
          LEFT JOIN (
            SELECT booking_id, SUM(amount) AS paid_amount
            FROM payments
            GROUP BY booking_id
          ) p ON p.booking_id = b.id
          WHERE b.status IN ('Reserved', 'CheckedIn', 'CheckedOut')
        ) items
        WHERE balance > 0
        ORDER BY balance DESC
        """
    )


def calendar_items(from_date=None, to_date=None):
    where_parts = ["b.status NOT IN ('Cancelled')"]
    params = []
    if from_date:
        where_parts.append("b.check_out >= ?")
        params.append(from_date)
    if to_date:
        where_parts.append("b.check_in <= ?")
        params.append(to_date)
    where = "WHERE " + " AND ".join(where_parts)
    return {
        "rooms": room_list(),
        "bookings": booking_select(where, tuple(params)),
    }


def reminders(target_date=None, search_text="", booking_id=None):
    target_date = target_date or date.today().isoformat()
    search_text = str(search_text or "").strip().lower()
    booking_id = integer(booking_id) if booking_id else None
    due = debtors()
    arrivals = booking_select("WHERE b.check_in = ? AND b.status = 'Reserved'", (target_date,))
    departures = booking_select("WHERE b.check_out = ? AND b.status = 'CheckedIn'", (target_date,))
    if booking_id:
        due = [item for item in due if integer(item["id"]) == booking_id]
        arrivals = [item for item in arrivals if integer(item["id"]) == booking_id]
        departures = [item for item in departures if integer(item["id"]) == booking_id]
    if search_text:
        def matches(item):
            hay = " ".join([
                str(item.get("guest_name") or ""),
                str(item.get("guest_phone") or ""),
                str(item.get("room_number") or ""),
                str(item.get("id") or ""),
            ]).lower()
            return search_text in hay
        due = [item for item in due if matches(item)]
        arrivals = [item for item in arrivals if matches(item)]
        departures = [item for item in departures if matches(item)]
    for item in due:
        text = f"Salam {item['guest_name']}, Hotel 50 üzrə qalıq borcunuz: {money(item['balance'])} AZN."
        sms_text = f"Hotel 50: {item['guest_name']}, qalıq borcunuz {money(item['balance'])} AZN-dir."
        item["message_text"] = text
        item["sms_text"] = sms_text
        item["whatsapp_url"] = f"https://wa.me/{''.join(ch for ch in str(item.get('guest_phone') or '') if ch.isdigit())}?text={quote(text)}"
        item["sms_url"] = f"sms:{''.join(ch for ch in str(item.get('guest_phone') or '') if ch.isdigit())}?body={quote(sms_text)}"
    return {"date": target_date, "debtors": due, "arrivals": arrivals, "departures": departures}


def summary():
    rooms_data = room_list()
    total_beds = sum(integer(r["capacity"]) for r in rooms_data)
    occupied = sum(integer(r["occupied"]) for r in rooms_data)
    today = date.today().isoformat()
    month = today[:7]
    money_row = row(
        """
        SELECT
          COALESCE(SUM(b.total_amount + COALESCE(ro.room_order_amount, 0) + COALESCE(b.late_fee, 0)), 0) AS total_amount,
          COALESCE(SUM(payments.paid), 0) AS paid_amount
        FROM bookings b
        LEFT JOIN (
          SELECT booking_id, SUM(amount) AS room_order_amount
          FROM room_orders
          WHERE booking_id IS NOT NULL AND status = 'Çatdırıldı'
          GROUP BY booking_id
        ) ro ON ro.booking_id = b.id
        LEFT JOIN (
          SELECT booking_id, SUM(amount) AS paid FROM payments GROUP BY booking_id
        ) payments ON payments.booking_id = b.id
        WHERE b.status IN ('Reserved', 'CheckedIn')
        """
    )
    month_row = row(
        """
        SELECT
          COALESCE((SELECT SUM(amount) FROM payments WHERE substr(paid_at, 1, 7) = ?), 0) AS income,
          COALESCE((SELECT SUM(amount) FROM expenses WHERE substr(spent_at, 1, 7) = ?), 0) AS expense
        """,
        (month, month),
    )
    return {
        "total_rooms": len(rooms_data),
        "total_beds": total_beds,
        "occupied_beds": occupied,
        "free_beds": total_beds - occupied,
        "active_guests": row("SELECT COALESCE(SUM(people_count), 0) AS c FROM bookings WHERE status = 'CheckedIn'")["c"],
        "arrivals_today": row("SELECT COUNT(*) AS c FROM bookings WHERE check_in = ? AND status = 'Reserved'", (today,))["c"],
        "departures_today": row("SELECT COUNT(*) AS c FROM bookings WHERE check_out = ? AND status = 'CheckedIn'", (today,))["c"],
        "debt": round(money_row["total_amount"] - money_row["paid_amount"], 2),
        "month_income": round(month_row["income"], 2),
        "month_expense": round(month_row["expense"], 2),
        "month_profit": round(month_row["income"] - month_row["expense"], 2),
    }


def monthly_report():
    """Last 12 months income / expense / profit."""
    today = date.today()
    result = []
    for i in range(11, -1, -1):
        month_num = today.month - i
        year = today.year
        while month_num <= 0:
            month_num += 12
            year -= 1
        month_str = f"{year}-{month_num:02d}"
        income = row(
            "SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE substr(paid_at, 1, 7) = ?",
            (month_str,),
        )["t"]
        expense = row(
            "SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE substr(spent_at, 1, 7) = ?",
            (month_str,),
        )["t"]
        result.append({
            "month": month_str,
            "income": round(income, 2),
            "expense": round(expense, 2),
            "profit": round(income - expense, 2),
        })
    return result


def occupancy_report():
    """Last 30 days occupancy rate."""
    today = date.today()
    rooms_data = room_list()
    total_beds = sum(integer(r["capacity"]) for r in rooms_data)
    if total_beds == 0:
        return []
    result = []
    for i in range(29, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        occupied = row(
            """
            SELECT COALESCE(SUM(people_count), 0) AS total
            FROM bookings
            WHERE status NOT IN ('Cancelled')
              AND check_in <= ? AND check_out > ?
            """,
            (d, d),
        )["total"]
        result.append({
            "date": d,
            "occupied": occupied,
            "total": total_beds,
            "rate": round(min(occupied / total_beds * 100, 100), 1),
        })
    return result


# ─────────────────────── HTTP Handler ───────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC), **kwargs)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message, status=400):
        self.send_json({"error": message}, status)

    def send_text(self, body, content_type="text/plain; charset=utf-8", status=200, filename=None):
        data = str(body).encode("utf-8")
        return self.send_bytes(data, content_type, status=status, filename=filename)

    def send_bytes(self, data, content_type="application/octet-stream", status=200, filename=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def authenticated(self):
        header = self.headers.get("Authorization", "")
        bearer = header[7:] if header.startswith("Bearer ") else ""
        cookie = parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME, "")
        token = bearer or cookie
        self._auth_token = token
        user = get_session_user(token)
        if user:
            self.current_user = user
        return bool(user)

    def require_auth(self, roles=None):
        if self.authenticated() and (not roles or self.current_user["role"] in roles):
            return True
        self.send_error_json(
            "Unauthorized" if not getattr(self, "current_user", None) else "Forbidden",
            401 if not getattr(self, "current_user", None) else 403,
        )
        return False

    def set_cookie(self, token):
        self.send_header(
            "Set-Cookie",
            f"{COOKIE_NAME}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
        )

    def clear_cookie(self):
        self.send_header("Set-Cookie", f"{COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0")

    def send_login_success(self, user, token):
        body = json.dumps({"user": public_user(user)}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.set_cookie(token)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Suppress noisy access logs for API calls; keep errors
        if args and str(args[1]) not in ("200", "201", "304"):
            super().log_message(fmt, *args)

    # ── GET ────────────────────────────────────────────────────────────────────

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)
        try:
            if path == "/api/auth/session":
                if not self.authenticated():
                    return self.send_error_json("Unauthorized", 401)
                return self.send_json({"user": public_user(self.current_user)})

            if path == "/api/backup":
                if not self.require_auth({"Admin"}):
                    return
                BACKUP_DIR.mkdir(exist_ok=True)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                target = BACKUP_DIR / f"hotel50-{stamp}.db"
                shutil.copy2(DB_PATH, target)
                audit(self.current_user["username"], "backup.created", "backup", target.name)
                return self.send_json({"file": str(target), "name": target.name})

            if path == "/api/backups":
                if not self.require_auth({"Admin"}):
                    return
                BACKUP_DIR.mkdir(exist_ok=True)
                backups = [
                    {"name": item.name, "size": item.stat().st_size}
                    for item in sorted(BACKUP_DIR.glob("hotel50-*.db"), reverse=True)
                ]
                return self.send_json(backups)

            if path == "/api/users":
                if not self.require_auth({"Admin"}):
                    return
                return self.send_json([public_user(u) for u in rows("SELECT * FROM users ORDER BY created_at DESC")])

            if path == "/api/audit":
                if not self.require_auth({"Admin"}):
                    return
                page = integer(qs.get("page", ["1"])[0], 1)
                limit = min(integer(qs.get("limit", ["100"])[0], 100), 500)
                offset = (page - 1) * limit
                total = row("SELECT COUNT(*) AS c FROM audit_logs")["c"]
                data = rows(
                    "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?",
                    (limit, offset),
                )
                return self.send_json({"data": data, "total": total, "page": page, "limit": limit})

            if path == "/api/summary":
                if not self.require_auth():
                    return
                return self.send_json(summary())

            if path == "/api/public/room-categories":
                return self.send_json(parse_categories(rows("SELECT * FROM room_categories ORDER BY name")))

            if path == "/api/room-categories":
                if not self.require_auth():
                    return
                return self.send_json(parse_categories(rows("SELECT * FROM room_categories ORDER BY name")))

            if path == "/api/rooms":
                if not self.require_auth(ROLES):
                    return
                return self.send_json(room_list())

            if path == "/api/guests":
                if not self.require_auth(OPS_ROLES):
                    return
                q = qs.get("q", [""])[0].strip()
                if q:
                    like = f"%{q}%"
                    return self.send_json(rows(
                        "SELECT * FROM guests WHERE full_name LIKE ? OR phone LIKE ? OR document_no LIKE ? ORDER BY created_at DESC",
                        (like, like, like),
                    ))
                return self.send_json(rows("SELECT * FROM guests ORDER BY created_at DESC"))

            if path == "/api/documents":
                if not self.require_auth(OPS_ROLES):
                    return
                return self.send_json(rows("""
                    SELECT d.id, d.guest_id, d.title, d.file_name, d.content_type, d.storage_type, d.created_at,
                           g.full_name AS guest_name
                    FROM guest_documents d
                    JOIN guests g ON g.id = d.guest_id
                    ORDER BY d.created_at DESC
                """))

            if path == "/api/debtors":
                if not self.require_auth(MONEY_ROLES):
                    return
                return self.send_json(debtors())

            if path == "/api/calendar":
                if not self.require_auth():
                    return
                from_date = qs.get("from", [None])[0]
                to_date = qs.get("to", [None])[0]
                return self.send_json(calendar_items(from_date, to_date))

            if path == "/api/reminders":
                if not self.require_auth(MONEY_ROLES):
                    return
                return self.send_json(reminders(
                    target_date=qs.get("date", [""])[0].strip() or None,
                    search_text=qs.get("q", [""])[0].strip(),
                    booking_id=qs.get("booking_id", [""])[0].strip() or None,
                ))

            if path == "/api/booking-requests":
                if not self.require_auth(OPS_ROLES):
                    return
                return self.send_json(rows("SELECT * FROM booking_requests ORDER BY created_at DESC"))

            if path == "/api/bookings":
                if not self.require_auth():
                    return
                q = qs.get("q", [""])[0].strip()
                status_f = qs.get("status", [""])[0].strip()
                where_parts = []
                params_list = []
                if q:
                    like = f"%{q}%"
                    where_parts.append("(g.full_name LIKE ? OR r.number LIKE ? OR g.phone LIKE ?)")
                    params_list.extend([like, like, like])
                if status_f:
                    where_parts.append("b.status = ?")
                    params_list.append(status_f)
                where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
                return self.send_json(booking_select(where, tuple(params_list)))

            if path == "/api/payments":
                if not self.require_auth(MONEY_ROLES):
                    return
                return self.send_json(rows("""
                    SELECT p.*, b.id AS booking_id, g.full_name AS guest_name, r.number AS room_number
                    FROM payments p
                    JOIN bookings b ON b.id = p.booking_id
                    JOIN guests g ON g.id = b.guest_id
                    JOIN rooms r ON r.id = b.room_id
                    ORDER BY p.created_at DESC
                """))

            if path == "/api/room-orders":
                if not self.require_auth(OPS_ROLES):
                    return
                return self.send_json(rows("""
                    SELECT o.*, r.number AS room_number,
                           g.full_name AS guest_name
                    FROM room_orders o
                    JOIN rooms r ON r.id = o.room_id
                    LEFT JOIN bookings b ON b.id = o.booking_id
                    LEFT JOIN guests g ON g.id = b.guest_id
                    ORDER BY o.created_at DESC
                """))

            if path == "/api/expenses":
                if not self.require_auth(MONEY_ROLES):
                    return
                cat   = qs.get("category", [""])[0].strip()
                from_d = qs.get("from", [""])[0].strip()
                to_d   = qs.get("to",   [""])[0].strip()
                where_parts, params_list = [], []
                if cat:
                    where_parts.append("category = ?")
                    params_list.append(cat)
                if from_d:
                    where_parts.append("spent_at >= ?")
                    params_list.append(from_d)
                if to_d:
                    where_parts.append("spent_at <= ?")
                    params_list.append(to_d)
                where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
                return self.send_json(rows(
                    f"SELECT * FROM expenses {where} ORDER BY spent_at DESC, created_at DESC",
                    tuple(params_list),
                ))

            if path == "/api/reports/monthly":
                if not self.require_auth(MONEY_ROLES):
                    return
                return self.send_json(monthly_report())

            if path == "/api/reports/occupancy":
                if not self.require_auth(MONEY_ROLES):
                    return
                return self.send_json(occupancy_report())

            if path == "/api/export/monthly":
                if not self.require_auth(MONEY_ROLES):
                    return
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(["type", "date", "name", "room_or_category", "amount", "service_amount", "late_fee", "paid", "balance", "note"])
                for b in booking_select():
                    writer.writerow(["booking", b["check_in"], b["guest_name"], b["room_number"],
                                     b["total_amount"], b["room_order_amount"], b["late_fee"], b["paid_amount"], b["balance"], b["note"]])
                for o in rows(
                    """
                    SELECT o.*, g.full_name AS guest_name, r.number AS room_number
                    FROM room_orders o
                    JOIN rooms r ON r.id = o.room_id
                    LEFT JOIN bookings b ON b.id = o.booking_id
                    LEFT JOIN guests g ON g.id = b.guest_id
                    WHERE o.status = 'Çatdırıldı'
                    ORDER BY o.created_at DESC
                    """
                ):
                    writer.writerow(["room_order", o["created_at"][:10], o["guest_name"] or "", o["room_number"],
                                     "", o["amount"], "", "", "", o["description"]])
                for e in rows("SELECT * FROM expenses ORDER BY spent_at DESC"):
                    writer.writerow(["expense", e["spent_at"], "", e["category"], e["amount"], "", "", "", "", e["note"]])
                return self.send_text(output.getvalue(), "text/csv; charset=utf-8", filename="hotel50-report.csv")

            # /api/receipts/:id
            parts = path.strip("/").split("/")
            if len(parts) == 3 and parts[:2] == ["api", "receipts"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                payment = row(
                    """
                    SELECT p.*, g.full_name AS guest_name, r.number AS room_number,
                           b.check_in, b.check_out, b.total_amount, COALESCE(b.late_fee, 0) AS late_fee,
                           COALESCE(ro.room_order_amount, 0) AS room_order_amount,
                           COALESCE(paid.total_paid, 0) AS total_paid
                    FROM payments p
                    JOIN bookings b ON b.id = p.booking_id
                    JOIN guests g ON g.id = b.guest_id
                    JOIN rooms r ON r.id = b.room_id
                    LEFT JOIN (
                      SELECT booking_id, SUM(amount) AS room_order_amount
                      FROM room_orders
                      WHERE booking_id IS NOT NULL AND status = 'Çatdırıldı'
                      GROUP BY booking_id
                    ) ro ON ro.booking_id = b.id
                    LEFT JOIN (
                      SELECT booking_id, SUM(amount) AS total_paid
                      FROM payments
                      GROUP BY booking_id
                    ) paid ON paid.booking_id = b.id
                    WHERE p.id = ?
                    """,
                    (integer(parts[2]),),
                )
                if not payment:
                    return self.send_error_json("Qəbz tapılmadı", 404)
                service_orders = rows(
                    """
                    SELECT category, description, amount
                    FROM room_orders
                    WHERE booking_id = ? AND status = 'Çatdırıldı'
                    ORDER BY created_at ASC
                    """,
                    (integer(payment["booking_id"]),),
                )
                grand_total = round(
                    money(payment["total_amount"]) + money(payment["room_order_amount"]) + money(payment["late_fee"]),
                    2,
                )
                remaining = round(grand_total - money(payment["total_paid"]), 2)
                service_html = ""
                if service_orders:
                    items = "".join(
                        f"<li>{html_escape(str(item['category'] or ''))}: {html_escape(str(item['description'] or ''))} "
                        f"<strong>{money(item['amount'])} AZN</strong></li>"
                        for item in service_orders
                    )
                    service_html = f"<dt>Əlavə sifarişlər</dt><dd><ul style='padding-left:18px;margin:0'>{items}</ul></dd>"
                html = f"""<!doctype html><html><head><meta charset='utf-8'><title>Qəbz #{payment['id']}</title>
                <style>body{{font-family:Arial;padding:32px}}.box{{border:1px solid #ddd;padding:20px;max-width:520px}}
                dt{{font-weight:bold;color:#667085;font-size:13px}}dd{{margin:0 0 10px;font-size:15px}}
                h1{{color:#0f766e}}</style></head>
                <body><div class='box'><h1>Hotel 50</h1><p style='color:#667085'>Ödəniş qəbzi</p><dl>
                <dt>Qəbz №</dt><dd>#{payment['id']}</dd>
                <dt>Qonaq</dt><dd>{html_escape(str(payment['guest_name'] or ''))}</dd>
                <dt>Otaq</dt><dd>{html_escape(str(payment['room_number'] or ''))}</dd>
                <dt>Qalma</dt><dd>{html_escape(str(payment['check_in'] or ''))} → {html_escape(str(payment['check_out'] or ''))}</dd>
                <dt>Otaq haqqı</dt><dd>{money(payment['total_amount'])} AZN</dd>
                <dt>Əlavə sifariş</dt><dd>{money(payment['room_order_amount'])} AZN</dd>
                <dt>Gecikmə</dt><dd>{money(payment['late_fee'])} AZN</dd>
                <dt>Yekun borc</dt><dd><strong>{grand_total} AZN</strong></dd>
                <dt>Ödəniş tarixi</dt><dd>{html_escape(str(payment['paid_at'] or ''))}</dd>
                <dt>Məbləğ</dt><dd><strong>{money(payment['amount'])} AZN</strong></dd>
                <dt>Bu günə qədər ödənilib</dt><dd>{money(payment['total_paid'])} AZN</dd>
                <dt>Qalıq</dt><dd><strong>{remaining} AZN</strong></dd>
                <dt>Metod</dt><dd>{html_escape(str(payment['method'] or ''))}</dd>
                {service_html}
                {f"<dt>Qeyd</dt><dd>{html_escape(str(payment['note']))}</dd>" if payment.get('note') else ""}
                </dl><button onclick='window.print()' style='padding:10px 20px;background:#0f766e;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:15px'>Çap et</button>
                </div></body></html>"""
                return self.send_text(html, "text/html; charset=utf-8")

            # /api/invoices/:booking_id
            if len(parts) == 3 and parts[:2] == ["api", "invoices"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                invoice = booking_financials(parts[2])
                if not invoice:
                    return self.send_error_json("Hesab-faktura tapılmadı", 404)
                service_html = ""
                if invoice["service_orders"]:
                    items = "".join(
                        f"<tr><td>{html_escape(str(item['created_at'])[:16].replace('T', ' '))}</td>"
                        f"<td>{html_escape(str(item['category'] or ''))}</td>"
                        f"<td>{html_escape(str(item['description'] or ''))}</td>"
                        f"<td style='text-align:right'>{money(item['amount'])} AZN</td></tr>"
                        for item in invoice["service_orders"]
                    )
                    service_html = (
                        "<h3 style='margin:24px 0 10px;color:#0f766e'>Əlavə sifarişlər</h3>"
                        "<table style='width:100%;border-collapse:collapse'>"
                        "<thead><tr><th style='text-align:left'>Tarix</th><th style='text-align:left'>Kateqoriya</th>"
                        "<th style='text-align:left'>Təsvir</th><th style='text-align:right'>Məbləğ</th></tr></thead>"
                        f"<tbody>{items}</tbody></table>"
                    )
                html = f"""<!doctype html><html><head><meta charset='utf-8'><title>Hesab-faktura #{invoice['id']}</title>
                <style>
                body{{font-family:Arial;padding:32px;color:#111827}} .box{{border:1px solid #ddd;padding:24px;max-width:760px}}
                h1,h3{{margin:0}} dl{{display:grid;grid-template-columns:170px 1fr;gap:8px 14px;margin:18px 0}}
                dt{{font-weight:bold;color:#667085;font-size:13px}} dd{{margin:0;font-size:15px}}
                .totals{{margin-top:20px;border-top:1px solid #e5e7eb;padding-top:16px}}
                .totals div{{display:flex;justify-content:space-between;padding:4px 0}} th,td{{padding:8px 6px;border-bottom:1px solid #f1f5f9;font-size:14px}}
                </style></head>
                <body><div class='box'><h1 style='color:#0f766e'>Hotel 50</h1><p style='color:#667085'>Final hesab-faktura</p><dl>
                <dt>Bron №</dt><dd>#{invoice['id']}</dd>
                <dt>Qonaq</dt><dd>{html_escape(str(invoice['guest_name'] or ''))}</dd>
                <dt>Telefon</dt><dd>{html_escape(str(invoice['guest_phone'] or ''))}</dd>
                <dt>Otaq</dt><dd>{html_escape(str(invoice['room_number'] or ''))}</dd>
                <dt>Qalma</dt><dd>{html_escape(str(invoice['check_in'] or ''))} → {html_escape(str(invoice['check_out'] or ''))}</dd>
                <dt>Status</dt><dd>{html_escape(str(invoice['status'] or ''))}</dd>
                </dl>
                {service_html}
                <div class='totals'>
                  <div><span>Otaq haqqı</span><strong>{money(invoice['total_amount'])} AZN</strong></div>
                  <div><span>Əlavə sifarişlər</span><strong>{money(invoice['room_order_amount'])} AZN</strong></div>
                  <div><span>Gecikmə haqqı</span><strong>{money(invoice['late_fee'])} AZN</strong></div>
                  <div><span>Ödənilib</span><strong>{money(invoice['total_paid'])} AZN</strong></div>
                  <div style='font-size:18px;margin-top:8px'><span>Qalıq borc</span><strong>{money(invoice['balance'])} AZN</strong></div>
                </div>
                <button onclick='window.print()' style='margin-top:24px;padding:10px 20px;background:#0f766e;color:#fff;border:0;border-radius:6px;cursor:pointer;font-size:15px'>Çap et</button>
                </div></body></html>"""
                return self.send_text(html, "text/html; charset=utf-8")

            # /api/documents/:id
            if len(parts) == 3 and parts[:2] == ["api", "documents"]:
                if not self.require_auth(OPS_ROLES):
                    return
                doc = row("SELECT * FROM guest_documents WHERE id = ?", (integer(parts[2]),))
                if not doc:
                    return self.send_error_json("Sənəd tapılmadı", 404)
                content = document_payload(doc["data"], doc.get("storage_type") or "text")
                content_type = doc.get("content_type") or "application/octet-stream"
                return self.send_bytes(content, content_type)

            if path == "/managepage":
                content = (PUBLIC / "app.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
                return

            return super().do_GET()
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    # ── POST ───────────────────────────────────────────────────────────────────

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = json_body(self)

            if path == "/api/auth/login":
                if login_limited(self):
                    return self.send_error_json("Çox cəhd edildi. Bir az sonra yenidən yoxlayın.", 429)
                username = str(data.get("username") or "").strip()
                user = row("SELECT * FROM users WHERE username = ? AND active = 1", (username,))
                if not user or not verify_encoded_password(data.get("password"), user["password_hash"]):
                    record_login_failure(self)
                    return self.send_error_json("Yanlış istifadəçi adı və ya şifrə", 401)
                clear_login_failures(self)
                token = create_session(user["id"])
                audit(user["username"], "auth.login", "user", user["id"])
                return self.send_login_success(user, token)

            if path == "/api/auth/logout":
                token = getattr(self, "_auth_token", "") or parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME, "")
                if token:
                    u = get_session_user(token)
                    if u:
                        audit(u["username"], "auth.logout", "user", u["id"])
                    delete_session(token)
                body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.clear_cookie()
                self.end_headers()
                self.wfile.write(body)
                return

            if path == "/api/public/booking-requests":
                full_name = str(data.get("full_name") or "").strip()
                if not full_name:
                    return self.send_error_json("Ad soyad tələb olunur", 400)
                request_id = execute(
                    "INSERT INTO booking_requests (full_name, phone, check_in, check_out, people_count, note, room_category) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        full_name,
                        str(data.get("phone") or "").strip(),
                        str(data.get("check_in") or ""),
                        str(data.get("check_out") or ""),
                        integer(data.get("people_count"), 1),
                        str(data.get("note") or ""),
                        str(data.get("room_category") or ""),
                    ),
                )
                audit("public", "booking_request.created", "booking_request", request_id)
                return self.send_json({"id": request_id}, 201)

            if not self.require_auth():
                return

            if path == "/api/users":
                if not self.require_auth({"Admin"}):
                    return
                role = str(data.get("role") or "Reception")
                if role not in ROLES:
                    return self.send_error_json("Rol düzgün deyil", 400)
                password = str(data.get("password") or "")
                if len(password) < 6:
                    return self.send_error_json("Şifrə minimum 6 simvol olmalıdır", 400)
                user_id = execute(
                    "INSERT INTO users (username, full_name, role, password_hash, active) VALUES (?, ?, ?, ?, ?)",
                    (
                        str(data.get("username") or "").strip(),
                        str(data.get("full_name") or "").strip(),
                        role,
                        hash_password(password),
                        1 if str(data.get("active", "1")) != "0" else 0,
                    ),
                )
                audit(self.current_user["username"], "user.created", "user", user_id)
                return self.send_json({"id": user_id}, 201)

            if path == "/api/room-categories":
                if not self.require_auth({"Admin"}):
                    return
                name = str(data.get("name") or "").strip()
                if not name:
                    return self.send_error_json("Kateqoriya adı tələb olunur", 400)
                amenities = data.get("amenities") or []
                amenities_str = json.dumps(list(amenities) if isinstance(amenities, list) else [])
                try:
                    cat_id = execute(
                        "INSERT INTO room_categories (name, description, base_price, amenities) VALUES (?, ?, ?, ?)",
                        (name, str(data.get("description") or ""), money(data.get("base_price")), amenities_str),
                    )
                except sqlite3.IntegrityError:
                    return self.send_error_json("Bu kateqoriya adı artıq mövcuddur", 400)
                audit(self.current_user["username"], "room_category.created", "room_category", cat_id)
                return self.send_json({"id": cat_id}, 201)

            if path == "/api/rooms":
                if not self.require_auth({"Admin"}):
                    return
                room_id = execute(
                    "INSERT INTO rooms (number, floor, room_type, capacity, nightly_rate, note) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        str(data.get("number", "")).strip(),
                        integer(data.get("floor"), 1),
                        str(data.get("room_type") or "Standard"),
                        integer(data.get("capacity"), 1),
                        money(data.get("nightly_rate")),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "room.created", "room", room_id)
                return self.send_json({"id": room_id}, 201)

            if path == "/api/room-orders":
                if not self.require_auth(OPS_ROLES):
                    return
                bk_id = integer(data.get("booking_id")) or None
                if bk_id:
                    bk = row("SELECT id, status FROM bookings WHERE id = ?", (bk_id,))
                    if not bk:
                        return self.send_error_json("Bron tapılmadı", 404)
                    if bk["status"] not in ("Reserved", "CheckedIn"):
                        return self.send_error_json("Sifariş yalnız aktiv bron üçün yaradıla bilər", 400)
                order_id = execute(
                    "INSERT INTO room_orders (room_id, booking_id, category, description, amount, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        integer(data.get("room_id")),
                        bk_id,
                        str(data.get("category") or "Yemək"),
                        str(data.get("description") or "").strip(),
                        money(data.get("amount")),
                        str(data.get("status") or "Yeni"),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "room_order.created", "room_order", order_id)
                return self.send_json({"id": order_id}, 201)

            if path == "/api/guests":
                if not self.require_auth(OPS_ROLES):
                    return
                guest_id = execute(
                    "INSERT INTO guests (full_name, phone, document_no, note) VALUES (?, ?, ?, ?)",
                    (
                        str(data.get("full_name", "")).strip(),
                        str(data.get("phone") or ""),
                        str(data.get("document_no") or ""),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "guest.created", "guest", guest_id)
                return self.send_json({"id": guest_id}, 201)

            if path == "/api/bookings":
                if not self.require_auth(OPS_ROLES):
                    return
                ci = str(data.get("check_in") or "")
                co = str(data.get("check_out") or "")
                ok_d, msg_d = validate_dates(ci, co)
                if not ok_d:
                    return self.send_error_json(msg_d, 400)
                room_status = row("SELECT cleaning_status FROM rooms WHERE id = ?", (integer(data.get("room_id")),))
                if room_status and room_status["cleaning_status"] not in ("Təmiz", None, ""):
                    return self.send_error_json(
                        f"Bu otaq hazırda '{room_status['cleaning_status']}' statusundadır və bronlana bilməz", 400
                    )
                try:
                    total_amount = booking_room_total(integer(data.get("room_id")), ci, co)
                except ValueError as exc:
                    return self.send_error_json(str(exc), 404)
                ok, message = has_capacity(integer(data.get("room_id")), ci, co, integer(data.get("people_count"), 1))
                if not ok:
                    return self.send_error_json(message, 400)
                booking_id = execute(
                    "INSERT INTO bookings (guest_id, room_id, check_in, check_out, status, people_count, total_amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        integer(data.get("guest_id")),
                        integer(data.get("room_id")),
                        ci, co,
                        str(data.get("status") or "Reserved"),
                        integer(data.get("people_count"), 1),
                        total_amount,
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "booking.created", "booking", booking_id)
                return self.send_json({"id": booking_id}, 201)

            if len(parts := path.strip("/").split("/")) == 4 and parts[:2] == ["api", "booking-requests"] and parts[3] == "convert":
                if not self.require_auth(OPS_ROLES):
                    return
                request_item = row("SELECT * FROM booking_requests WHERE id = ?", (integer(parts[2]),))
                if not request_item:
                    return self.send_error_json("Sorğu tapılmadı", 404)
                if request_item["status"] in ("Təsdiq", "İmtina"):
                    return self.send_error_json(f"Bu sorğu artıq '{request_item['status']}' statusundadır", 400)
                ci = str(data.get("check_in") or request_item.get("check_in") or "")
                co = str(data.get("check_out") or request_item.get("check_out") or "")
                ok_d, msg_d = validate_dates(ci, co)
                if not ok_d:
                    return self.send_error_json(msg_d, 400)
                room_id = integer(data.get("room_id"))
                people_count = integer(data.get("people_count"), integer(request_item.get("people_count"), 1))
                conv_room_status = row("SELECT cleaning_status FROM rooms WHERE id = ?", (room_id,))
                if conv_room_status and conv_room_status["cleaning_status"] not in ("Təmiz", None, ""):
                    return self.send_error_json(
                        f"Bu otaq hazırda '{conv_room_status['cleaning_status']}' statusundadır və bronlana bilməz", 400
                    )
                ok, message = has_capacity(room_id, ci, co, people_count)
                if not ok:
                    return self.send_error_json(message, 400)
                guest_id = execute(
                    "INSERT INTO guests (full_name, phone, document_no, note) VALUES (?, ?, ?, ?)",
                    (
                        str(request_item.get("full_name") or "").strip(),
                        str(request_item.get("phone") or "").strip(),
                        "",
                        str(data.get("note") or request_item.get("note") or ""),
                    ),
                )
                try:
                    total_amount = booking_room_total(room_id, ci, co)
                except ValueError as exc:
                    return self.send_error_json(str(exc), 404)
                booking_id = execute(
                    "INSERT INTO bookings (guest_id, room_id, check_in, check_out, status, people_count, total_amount, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        guest_id,
                        room_id,
                        ci,
                        co,
                        str(data.get("status") or "Reserved"),
                        people_count,
                        total_amount,
                        str(data.get("note") or request_item.get("note") or ""),
                    ),
                )
                handled_at = current_local_time().isoformat()
                execute(
                    "UPDATE booking_requests SET status = 'Təsdiq', handled_by = ?, handled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (self.current_user["username"], handled_at, integer(parts[2])),
                )
                audit(self.current_user["username"], "booking_request.converted", "booking_request", parts[2], booking_id)
                return self.send_json({"guest_id": guest_id, "booking_id": booking_id}, 201)

            if path == "/api/payments":
                if not self.require_auth(MONEY_ROLES):
                    return
                bk = row("SELECT status FROM bookings WHERE id = ?", (integer(data.get("booking_id")),))
                if not bk:
                    return self.send_error_json("Bron tapılmadı", 404)
                if bk["status"] == "Cancelled":
                    return self.send_error_json("Ləğv edilmiş bron üçün ödəniş əlavə etmək olmaz", 400)
                payment_id = execute(
                    "INSERT INTO payments (booking_id, amount, method, paid_at, note) VALUES (?, ?, ?, ?, ?)",
                    (
                        integer(data.get("booking_id")),
                        money(data.get("amount")),
                        str(data.get("method") or "Cash"),
                        str(data.get("paid_at") or date.today().isoformat()),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "payment.created", "payment", payment_id)
                return self.send_json({"id": payment_id}, 201)

            if path == "/api/expenses":
                if not self.require_auth(MONEY_ROLES):
                    return
                expense_id = execute(
                    "INSERT INTO expenses (category, amount, spent_at, note) VALUES (?, ?, ?, ?)",
                    (
                        str(data.get("category") or "").strip(),
                        money(data.get("amount")),
                        str(data.get("spent_at") or date.today().isoformat()),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "expense.created", "expense", expense_id)
                return self.send_json({"id": expense_id}, 201)

            if path == "/api/restore":
                if not self.require_auth({"Admin"}):
                    return
                name = Path(str(data.get("name") or "")).name
                source = BACKUP_DIR / name
                if not source.exists() or not source.name.startswith("hotel50-"):
                    return self.send_error_json("Backup tapılmadı", 404)
                stamp = time.strftime("%Y%m%d-%H%M%S")
                shutil.copy2(DB_PATH, BACKUP_DIR / f"hotel50-before-restore-{stamp}.db")
                shutil.copy2(source, DB_PATH)
                audit(self.current_user["username"], "backup.restored", "backup", name)
                return self.send_json({"ok": True})

            if path == "/api/backups/delete":
                if not self.require_auth({"Admin"}):
                    return
                names = data.get("names")
                if not isinstance(names, list):
                    return self.send_error_json("Backup siyahısı düzgün deyil", 400)
                deleted = []
                for raw_name in names:
                    name = Path(str(raw_name or "")).name
                    target = BACKUP_DIR / name
                    if not name.startswith("hotel50-") or target.parent != BACKUP_DIR or not target.exists():
                        continue
                    target.unlink()
                    deleted.append(name)
                    audit(self.current_user["username"], "backup.deleted", "backup", name)
                return self.send_json({"deleted": deleted})

            # /api/guests/:id/documents
            doc_match = path.strip("/").split("/")
            if len(doc_match) == 4 and doc_match[:2] == ["api", "guests"] and doc_match[3] == "documents":
                if not self.require_auth(OPS_ROLES):
                    return
                title = str(data.get("title") or "Sənəd").strip()
                file_name = str(data.get("file_name") or "document.txt").strip()
                content_type = str(data.get("content_type") or "text/plain").strip() or "application/octet-stream"
                data_base64 = str(data.get("data_base64") or "").strip()
                raw_data = data_base64 or str(data.get("data") or "")
                storage_type = "base64" if data_base64 else "text"
                if not raw_data:
                    return self.send_error_json("Sənəd faylı boşdur", 400)
                if len(raw_data) > MAX_DOC_SIZE:
                    return self.send_error_json(
                        f"Fayl həcmi limitdən böyükdür (max {MAX_DOC_SIZE // (1024*1024)} MB)", 413
                    )
                doc_id = execute(
                    "INSERT INTO guest_documents (guest_id, title, file_name, content_type, data, storage_type) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        integer(doc_match[2]),
                        title,
                        file_name,
                        content_type,
                        raw_data,
                        storage_type,
                    ),
                )
                audit(self.current_user["username"], "document.created", "document", doc_id)
                return self.send_json({"id": doc_id}, 201)

            return self.send_error_json("Not found", 404)
        except sqlite3.IntegrityError as exc:
            return self.send_error_json(f"Məlumat düzgün deyil: {exc}", 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    # ── PUT ────────────────────────────────────────────────────────────────────

    def do_PUT(self):
        path = urlparse(self.path).path
        try:
            if not self.require_auth():
                return
            data = json_body(self)
            parts = path.strip("/").split("/")

            if len(parts) == 3 and parts[:2] == ["api", "room-categories"]:
                if not self.require_auth({"Admin"}):
                    return
                name = str(data.get("name") or "").strip()
                if not name:
                    return self.send_error_json("Kateqoriya adı tələb olunur", 400)
                amenities = data.get("amenities") or []
                amenities_str = json.dumps(list(amenities) if isinstance(amenities, list) else [])
                cat_id = integer(parts[2])
                current = row("SELECT name FROM room_categories WHERE id = ?", (cat_id,))
                if not current:
                    return self.send_error_json("Kateqoriya tapılmadı", 404)
                old_name = str(current["name"] or "")
                try:
                    with connect() as db:
                        db.execute(
                            "UPDATE room_categories SET name = ?, description = ?, base_price = ?, amenities = ? WHERE id = ?",
                            (name, str(data.get("description") or ""), money(data.get("base_price")), amenities_str, cat_id),
                        )
                        if old_name and old_name != name:
                            db.execute("UPDATE rooms SET room_type = ? WHERE room_type = ?", (name, old_name))
                        db.commit()
                except sqlite3.IntegrityError:
                    return self.send_error_json("Bu kateqoriya adı artıq mövcuddur", 400)
                audit(self.current_user["username"], "room_category.updated", "room_category", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "rooms"]:
                if not self.require_auth({"Admin"}):
                    return
                execute(
                    "UPDATE rooms SET number = ?, floor = ?, room_type = ?, capacity = ?, nightly_rate = ?, note = ? WHERE id = ?",
                    (
                        str(data.get("number") or "").strip(),
                        integer(data.get("floor"), 1),
                        str(data.get("room_type") or "Standard"),
                        integer(data.get("capacity"), 1),
                        money(data.get("nightly_rate")),
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "room.updated", "room", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "room-orders"]:
                if not self.require_auth(OPS_ROLES):
                    return
                bk_id = integer(data.get("booking_id")) or None
                if bk_id:
                    bk = row("SELECT id, status FROM bookings WHERE id = ?", (bk_id,))
                    if not bk:
                        return self.send_error_json("Bron tapılmadı", 404)
                    if bk["status"] not in ("Reserved", "CheckedIn"):
                        return self.send_error_json("Sifariş yalnız aktiv bron üçün saxlanıla bilər", 400)
                execute(
                    "UPDATE room_orders SET room_id = ?, booking_id = ?, category = ?, description = ?, amount = ?, status = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (
                        integer(data.get("room_id")),
                        bk_id,
                        str(data.get("category") or "Yemək"),
                        str(data.get("description") or "").strip(),
                        money(data.get("amount")),
                        str(data.get("status") or "Yeni"),
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "room_order.updated", "room_order", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "guests"]:
                if not self.require_auth(OPS_ROLES):
                    return
                execute(
                    "UPDATE guests SET full_name = ?, phone = ?, document_no = ?, note = ? WHERE id = ?",
                    (
                        str(data.get("full_name") or "").strip(),
                        str(data.get("phone") or ""),
                        str(data.get("document_no") or ""),
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "guest.updated", "guest", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "bookings"]:
                if not self.require_auth(OPS_ROLES):
                    return
                ci = str(data.get("check_in") or "")
                co = str(data.get("check_out") or "")
                ok_d, msg_d = validate_dates(ci, co)
                if not ok_d:
                    return self.send_error_json(msg_d, 400)
                existing_bk = row("SELECT status, late_fee, actual_check_out_at FROM bookings WHERE id = ?", (integer(parts[2]),))
                if not existing_bk:
                    return self.send_error_json("Bron tapılmadı", 404)
                status = str(data.get("status") or existing_bk["status"])
                if status != existing_bk["status"]:
                    _valid_transitions = {
                        "Reserved":   {"CheckedIn", "Cancelled"},
                        "CheckedIn":  {"CheckedOut", "Cancelled"},
                        "CheckedOut": set(),
                        "Cancelled":  set(),
                    }
                    if status not in _valid_transitions.get(existing_bk["status"], set()):
                        return self.send_error_json(
                            f"'{existing_bk['status']}' statusundan '{status}' statusuna keçid mümkün deyil", 400
                        )
                try:
                    total_amount = booking_room_total(integer(data.get("room_id")), ci, co)
                except ValueError as exc:
                    return self.send_error_json(str(exc), 404)
                ok, message = has_capacity(integer(data.get("room_id")), ci, co, integer(data.get("people_count"), 1), integer(parts[2]))
                if not ok:
                    return self.send_error_json(message, 400)
                late_fee = money(data["late_fee"]) if "late_fee" in data else money(existing_bk["late_fee"])
                actual_check_out_at = str(existing_bk.get("actual_check_out_at") or "")
                if status == "CheckedOut" and existing_bk["status"] != "CheckedOut":
                    booking_item = {
                        "check_out": co,
                        "room_rate": row("SELECT nightly_rate AS room_rate FROM rooms WHERE id = ?", (integer(data.get("room_id")),))["room_rate"],
                    }
                    actual_checkout_dt = current_local_time()
                    late_fee = calculate_late_fee(booking_item, actual_checkout_dt)
                    actual_check_out_at = actual_checkout_dt.isoformat()
                execute(
                    "UPDATE bookings SET guest_id = ?, room_id = ?, check_in = ?, check_out = ?, status = ?, people_count = ?, total_amount = ?, late_fee = ?, actual_check_out_at = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (
                        integer(data.get("guest_id")),
                        integer(data.get("room_id")),
                        ci, co,
                        status,
                        integer(data.get("people_count"), 1),
                        total_amount,
                        late_fee,
                        actual_check_out_at,
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "booking.updated", "booking", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "payments"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                execute(
                    "UPDATE payments SET booking_id = ?, amount = ?, method = ?, paid_at = ?, note = ? WHERE id = ?",
                    (
                        integer(data.get("booking_id")),
                        money(data.get("amount")),
                        str(data.get("method") or "Cash"),
                        str(data.get("paid_at") or date.today().isoformat()),
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "payment.updated", "payment", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "expenses"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                execute(
                    "UPDATE expenses SET category = ?, amount = ?, spent_at = ?, note = ? WHERE id = ?",
                    (
                        str(data.get("category") or "").strip(),
                        money(data.get("amount")),
                        str(data.get("spent_at") or date.today().isoformat()),
                        str(data.get("note") or ""),
                        integer(parts[2]),
                    ),
                )
                audit(self.current_user["username"], "expense.updated", "expense", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "users"]:
                if not self.require_auth({"Admin"}):
                    return
                role = str(data.get("role") or "Reception")
                if role not in ROLES:
                    return self.send_error_json("Rol düzgün deyil", 400)
                execute(
                    "UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?",
                    (
                        str(data.get("full_name") or "").strip(),
                        role,
                        1 if str(data.get("active", "1")) != "0" else 0,
                        integer(parts[2]),
                    ),
                )
                password = str(data.get("password") or "")
                if password:
                    if len(password) < 6:
                        return self.send_error_json("Şifrə minimum 6 simvol olmalıdır", 400)
                    execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), integer(parts[2])))
                audit(self.current_user["username"], "user.updated", "user", parts[2])
                return self.send_json({"ok": True})

            return self.send_error_json("Not found", 404)
        except sqlite3.IntegrityError as exc:
            return self.send_error_json(f"Məlumat düzgün deyil: {exc}", 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    # ── DELETE ─────────────────────────────────────────────────────────────────

    def do_DELETE(self):
        path = urlparse(self.path).path
        try:
            if not self.require_auth():
                return
            parts = path.strip("/").split("/")

            if len(parts) == 3 and parts[:2] == ["api", "backups"]:
                if not self.require_auth({"Admin"}):
                    return
                name = Path(parts[2]).name
                target = BACKUP_DIR / name
                if not name.startswith("hotel50-") or target.parent != BACKUP_DIR or not target.exists():
                    return self.send_error_json("Backup tapılmadı", 404)
                target.unlink()
                audit(self.current_user["username"], "backup.deleted", "backup", name)
                return self.send_json({"ok": True, "deleted": name})

            if len(parts) == 3 and parts[:2] == ["api", "room-categories"]:
                if not self.require_auth({"Admin"}):
                    return
                in_use = row("SELECT COUNT(*) AS c FROM rooms WHERE room_type = (SELECT name FROM room_categories WHERE id = ?)", (integer(parts[2]),))
                if in_use and in_use["c"] > 0:
                    return self.send_error_json("Bu kateqoriya otaqlarda istifadə olunur, silinə bilməz", 400)
                execute("DELETE FROM room_categories WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "room_category.deleted", "room_category", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "rooms"]:
                if not self.require_auth({"Admin"}):
                    return
                execute("DELETE FROM rooms WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "room.deleted", "room", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "guests"]:
                if not self.require_auth(OPS_ROLES):
                    return
                execute("DELETE FROM guest_documents WHERE guest_id = ?", (integer(parts[2]),))
                execute("DELETE FROM guests WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "guest.deleted", "guest", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "bookings"]:
                if not self.require_auth(OPS_ROLES):
                    return
                execute("DELETE FROM payments WHERE booking_id = ?", (integer(parts[2]),))
                execute("DELETE FROM bookings WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "booking.deleted", "booking", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "payments"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                execute("DELETE FROM payments WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "payment.deleted", "payment", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "expenses"]:
                if not self.require_auth(MONEY_ROLES):
                    return
                execute("DELETE FROM expenses WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "expense.deleted", "expense", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "documents"]:
                if not self.require_auth(OPS_ROLES):
                    return
                execute("DELETE FROM guest_documents WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "document.deleted", "document", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "room-orders"]:
                if not self.require_auth(OPS_ROLES):
                    return
                execute("DELETE FROM room_orders WHERE id = ?", (integer(parts[2]),))
                audit(self.current_user["username"], "room_order.deleted", "room_order", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 3 and parts[:2] == ["api", "users"]:
                if not self.require_auth({"Admin"}):
                    return
                uid = integer(parts[2])
                if uid == self.current_user["id"]:
                    return self.send_error_json("Özünüzü silə bilməzsiniz", 400)
                target_u = row("SELECT role FROM users WHERE id = ?", (uid,))
                if target_u and target_u["role"] == "Admin":
                    remaining = row("SELECT COUNT(*) AS c FROM users WHERE role = 'Admin' AND active = 1 AND id <> ?", (uid,))
                    if not remaining or remaining["c"] == 0:
                        return self.send_error_json("Sistemdə ən azı bir aktiv Admin olmalıdır", 400)
                execute("DELETE FROM sessions WHERE user_id = ?", (uid,))
                execute("DELETE FROM users WHERE id = ?", (uid,))
                audit(self.current_user["username"], "user.deleted", "user", parts[2])
                return self.send_json({"ok": True})

            return self.send_error_json("Not found", 404)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    # ── PATCH ──────────────────────────────────────────────────────────────────

    def do_PATCH(self):
        path = urlparse(self.path).path
        try:
            if not self.require_auth():
                return
            parts = path.strip("/").split("/")

            if len(parts) == 4 and parts[:2] == ["api", "bookings"] and parts[3] == "status":
                if not self.require_auth(OPS_ROLES):
                    return
                data = json_body(self)
                status = str(data.get("status") or "")
                if status not in {"Reserved", "CheckedIn", "CheckedOut", "Cancelled"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                booking_item = row(
                    """
                    SELECT b.*, r.nightly_rate AS room_rate
                    FROM bookings b
                    JOIN rooms r ON r.id = b.room_id
                    WHERE b.id = ?
                    """,
                    (integer(parts[2]),),
                )
                if not booking_item:
                    return self.send_error_json("Bron tapılmadı", 404)
                _valid_transitions = {
                    "Reserved":   {"CheckedIn", "Cancelled"},
                    "CheckedIn":  {"CheckedOut", "Cancelled"},
                    "CheckedOut": set(),
                    "Cancelled":  set(),
                }
                current_status = str(booking_item.get("status") or "")
                if status not in _valid_transitions.get(current_status, set()):
                    return self.send_error_json(
                        f"'{current_status}' statusundan '{status}' statusuna keçid mümkün deyil", 400
                    )
                late_fee = money(booking_item.get("late_fee"))
                actual_check_out_at = str(booking_item.get("actual_check_out_at") or "")
                if status == "CheckedOut":
                    actual_checkout_dt = current_local_time()
                    late_fee = calculate_late_fee(booking_item, actual_checkout_dt)
                    actual_check_out_at = actual_checkout_dt.isoformat()
                execute(
                    "UPDATE bookings SET status = ?, late_fee = ?, actual_check_out_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (status, late_fee, actual_check_out_at, integer(parts[2])),
                )
                audit(self.current_user["username"], f"booking.{status}", "booking", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 4 and parts[:2] == ["api", "rooms"] and parts[3] == "cleaning":
                if not self.require_auth(OPS_ROLES):
                    return
                data = json_body(self)
                status = str(data.get("cleaning_status") or "")
                if status not in {"Təmiz", "Çirkli", "Təmizlikdə", "Təmir lazımdır"}:
                    return self.send_error_json("Təmizlik statusu düzgün deyil", 400)
                execute("UPDATE rooms SET cleaning_status = ? WHERE id = ?", (status, integer(parts[2])))
                audit(self.current_user["username"], f"room.cleaning.{status}", "room", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 4 and parts[:2] == ["api", "booking-requests"] and parts[3] == "status":
                if not self.require_auth(OPS_ROLES):
                    return
                data = json_body(self)
                status = str(data.get("status") or "")
                if status not in {"Yeni", "Baxılır", "Təsdiq", "İmtina"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                handled_at = current_local_time().isoformat()
                execute(
                    "UPDATE booking_requests SET status = ?, handled_by = ?, handled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (status, self.current_user["username"], handled_at, integer(parts[2])),
                )
                audit(self.current_user["username"], f"booking_request.{status}", "booking_request", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 4 and parts[:2] == ["api", "room-orders"] and parts[3] == "status":
                if not self.require_auth(OPS_ROLES):
                    return
                data = json_body(self)
                status = str(data.get("status") or "")
                if status not in {"Yeni", "Hazırlanır", "Çatdırıldı", "Ləğv edildi"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                current_order = row("SELECT status FROM room_orders WHERE id = ?", (integer(parts[2]),))
                if not current_order:
                    return self.send_error_json("Sifariş tapılmadı", 404)
                if current_order["status"] in ("Çatdırıldı", "Ləğv edildi"):
                    return self.send_error_json(
                        f"Bu sifariş artıq '{current_order['status']}' statusundadır", 400
                    )
                execute(
                    "UPDATE room_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (status, integer(parts[2])),
                )
                audit(self.current_user["username"], f"room_order.{status}", "room_order", parts[2])
                return self.send_json({"ok": True})

            if len(parts) == 4 and parts[:2] == ["api", "bookings"] and parts[3] == "late-fee":
                if not self.require_auth({"Admin"}):
                    return
                data = json_body(self)
                amount = money(data.get("late_fee"))
                if amount < 0:
                    return self.send_error_json("Gecikmə mənfi ola bilməz", 400)
                execute(
                    "UPDATE bookings SET late_fee = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (amount, integer(parts[2])),
                )
                audit(self.current_user["username"], "booking.late_fee.updated", "booking", parts[2], f"{amount} AZN")
                return self.send_json({"ok": True})

            return self.send_error_json("Not found", 404)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)


# ─────────────────────── Entry point ───────────────────────

if __name__ == "__main__":
    init_db()

    def _cleanup_loop():
        while True:
            time.sleep(3600)
            cleanup_expired()

    t = threading.Thread(target=_cleanup_loop, daemon=True, name="session-cleanup")
    t.start()

    port = integer(os.environ.get("PORT"), 8020)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Hotel 50  →  http://localhost:{port}")
    server.serve_forever()
