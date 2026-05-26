#!/usr/bin/env python3
import json
import os
import hashlib
import hmac
import sqlite3
import shutil
import secrets
import time
from datetime import date
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse

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
LOGIN_ATTEMPTS = {}
SESSIONS = {}
ROLES = {"Admin", "Reception", "Accounting"}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
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

            CREATE TABLE IF NOT EXISTS proposals (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              title TEXT NOT NULL,
              category TEXT NOT NULL DEFAULT 'Funksiya',
              priority TEXT NOT NULL DEFAULT 'Orta',
              status TEXT NOT NULL DEFAULT 'Təklif',
              description TEXT DEFAULT '',
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
            """
        )

        user_count = db.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        if user_count == 0:
            db.execute(
                "INSERT INTO users (username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                (ADMIN_USER, "System Admin", "Admin", ADMIN_PASSWORD_HASH),
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

        proposal_count = db.execute("SELECT COUNT(*) AS c FROM proposals").fetchone()["c"]
        if proposal_count == 0:
            proposals = [
                ("Otaq təqvimi", "Bron", "Yüksək", "Təklif", "Ay/gün görünüşündə otaqların dolu və boş tarixlərini göstərmək."),
                ("Check-in sənəd yükləmə", "Qonaq", "Yüksək", "Təklif", "Şəxsiyyət vəsiqəsi və müqavilə fayllarını qonaq kartına əlavə etmək."),
                ("PDF qəbz", "Mühasibat", "Yüksək", "Təklif", "Ödənişdən sonra qəbzi PDF kimi yaratmaq və çap etmək."),
                ("Aylıq hesabat export", "Hesabat", "Yüksək", "Təklif", "Gəlir, xərc, borc və doluluğu CSV/Excel faylına çıxarmaq."),
                ("Otaq təmizlik statusu", "Servis", "Orta", "Təklif", "Otaqları Təmiz, Təmizlikdə, Təmir lazımdır statusları ilə izləmək."),
                ("Borclular siyahısı", "Mühasibat", "Yüksək", "Təklif", "Qalıq borcu olan qonaqları ayrıca siyahıda göstərmək."),
                ("Gec çıxış və əlavə ödəniş", "Bron", "Orta", "Təklif", "Check-out gecikəndə əlavə ödəniş hesablamaq."),
                ("Online rezervasiya forması", "Portal", "Orta", "Təklif", "Müştərinin kənardan bron sorğusu göndərməsi üçün sadə forma."),
                ("SMS/WhatsApp xatırlatma", "Bildiriş", "Aşağı", "Təklif", "Giriş, çıxış və borc xatırlatmalarını göndərmək."),
                ("Backup restore", "Admin", "Yüksək", "Təklif", "Yaradılmış backup faylından database-i bərpa etmək."),
            ]
            db.executemany(
                "INSERT INTO proposals (title, category, priority, status, description) VALUES (?, ?, ?, ?, ?)",
                proposals,
            )


def rows(sql, params=()):
    with connect() as db:
        return [dict(row) for row in db.execute(sql, params).fetchall()]


def row(sql, params=()):
    with connect() as db:
        item = db.execute(sql, params).fetchone()
        return dict(item) if item else None


def execute(sql, params=()):
    with connect() as db:
        cur = db.execute(sql, params)
        db.commit()
        return cur.lastrowid


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


def verify_password(password):
    try:
        scheme, salt, expected = ADMIN_PASSWORD_HASH.split(":", 2)
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(
            str(password or "").encode("utf-8"),
            salt=salt.encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=64,
        ).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


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


def hash_password(password):
    salt = secrets.token_hex(8)
    hashed = hashlib.scrypt(
        str(password or "").encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=64,
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
            n=16384,
            r=8,
            p=1,
            dklen=64,
        ).hex()
        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


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


def booking_select(where="", params=()):
    sql = f"""
      SELECT b.*, g.full_name AS guest_name, g.phone AS guest_phone,
             r.number AS room_number, r.capacity AS room_capacity,
             COALESCE(SUM(p.amount), 0) AS paid_amount,
             b.total_amount - COALESCE(SUM(p.amount), 0) AS balance
      FROM bookings b
      JOIN guests g ON g.id = b.guest_id
      JOIN rooms r ON r.id = b.room_id
      LEFT JOIN payments p ON p.booking_id = b.id
      {where}
      GROUP BY b.id
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


def summary():
    rooms_data = room_list()
    total_beds = sum(integer(r["capacity"]) for r in rooms_data)
    occupied = sum(integer(r["occupied"]) for r in rooms_data)
    today = date.today().isoformat()
    month = today[:7]
    money_row = row(
        """
        SELECT
          COALESCE(SUM(b.total_amount), 0) AS total_amount,
          COALESCE(SUM(payments.paid), 0) AS paid_amount
        FROM bookings b
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

    def authenticated(self):
        header = self.headers.get("Authorization", "")
        bearer = header[7:] if header.startswith("Bearer ") else ""
        cookie = parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME, "")
        token = bearer or cookie
        user = SESSIONS.get(token)
        if user:
            self.current_user = user
        return bool(user)

    def require_auth(self, roles=None):
        if self.authenticated() and (not roles or self.current_user["role"] in roles):
            return True
        self.send_error_json("Unauthorized", 401 if not getattr(self, "current_user", None) else 403)
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

    def do_GET(self):
        path = urlparse(self.path).path
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
            if path == "/api/users":
                if not self.require_auth({"Admin"}):
                    return
                return self.send_json([public_user(u) for u in rows("SELECT * FROM users ORDER BY created_at DESC")])
            if path == "/api/audit":
                if not self.require_auth({"Admin"}):
                    return
                return self.send_json(rows("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100"))
            if path == "/api/summary":
                if not self.require_auth():
                    return
                return self.send_json(summary())
            if path == "/api/rooms":
                if not self.require_auth():
                    return
                return self.send_json(room_list())
            if path == "/api/guests":
                if not self.require_auth():
                    return
                return self.send_json(rows("SELECT * FROM guests ORDER BY created_at DESC"))
            if path == "/api/bookings":
                if not self.require_auth():
                    return
                return self.send_json(booking_select())
            if path == "/api/payments":
                if not self.require_auth():
                    return
                return self.send_json(rows("""
                    SELECT p.*, b.id AS booking_id, g.full_name AS guest_name, r.number AS room_number
                    FROM payments p
                    JOIN bookings b ON b.id = p.booking_id
                    JOIN guests g ON g.id = b.guest_id
                    JOIN rooms r ON r.id = b.room_id
                    ORDER BY p.created_at DESC
                """))
            if path == "/api/expenses":
                if not self.require_auth({"Admin", "Accounting"}):
                    return
                return self.send_json(rows("SELECT * FROM expenses ORDER BY spent_at DESC, created_at DESC"))
            if path == "/api/proposals":
                if not self.require_auth():
                    return
                return self.send_json(rows("""
                    SELECT * FROM proposals
                    ORDER BY
                      CASE priority WHEN 'Yüksək' THEN 1 WHEN 'Orta' THEN 2 ELSE 3 END,
                      id
                """))
            return super().do_GET()
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            data = json_body(self)
            if path == "/api/auth/login":
                if login_limited(self):
                    return self.send_error_json("Çox cəhd edildi. Bir az sonra yenidən yoxlayın.", 429)
                username = str(data.get("username") or "").strip()
                user = row("SELECT * FROM users WHERE username = ? AND active = 1", (username,))
                if not user and username == ADMIN_USER and verify_password(data.get("password")):
                    user = row("SELECT * FROM users WHERE username = ? AND active = 1", (username,))
                if not user or not verify_encoded_password(data.get("password"), user["password_hash"]):
                    record_login_failure(self)
                    return self.send_error_json("Yanlış istifadəçi adı və ya şifrə", 401)
                clear_login_failures(self)
                token = secrets.token_hex(32)
                SESSIONS[token] = user
                audit(user["username"], "auth.login", "user", user["id"])
                return self.send_login_success(user, token)
            if path == "/api/auth/logout":
                token = parse_cookies(self.headers.get("Cookie")).get(COOKIE_NAME, "")
                if token in SESSIONS:
                    audit(SESSIONS[token]["username"], "auth.logout", "user", SESSIONS[token]["id"])
                    SESSIONS.pop(token, None)
                body = json.dumps({"ok": True}, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.clear_cookie()
                self.end_headers()
                self.wfile.write(body)
                return
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
            if path == "/api/guests":
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
                booking_id = execute(
                    """
                    INSERT INTO bookings (guest_id, room_id, check_in, check_out, status, people_count, total_amount, note)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        integer(data.get("guest_id")),
                        integer(data.get("room_id")),
                        str(data.get("check_in") or ""),
                        str(data.get("check_out") or ""),
                        str(data.get("status") or "Reserved"),
                        integer(data.get("people_count"), 1),
                        money(data.get("total_amount")),
                        str(data.get("note") or ""),
                    ),
                )
                audit(self.current_user["username"], "booking.created", "booking", booking_id)
                return self.send_json({"id": booking_id}, 201)
            if path == "/api/payments":
                if not self.require_auth({"Admin", "Accounting"}):
                    return
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
                if not self.require_auth({"Admin", "Accounting"}):
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
            if path == "/api/proposals":
                if not self.require_auth({"Admin"}):
                    return
                priority = str(data.get("priority") or "Orta")
                status = str(data.get("status") or "Təklif")
                if priority not in {"Yüksək", "Orta", "Aşağı"}:
                    return self.send_error_json("Prioritet düzgün deyil", 400)
                if status not in {"Təklif", "Seçildi", "İcrada", "Hazır", "Gözləyir"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                proposal_id = execute(
                    "INSERT INTO proposals (title, category, priority, status, description) VALUES (?, ?, ?, ?, ?)",
                    (
                        str(data.get("title") or "").strip(),
                        str(data.get("category") or "Funksiya").strip(),
                        priority,
                        status,
                        str(data.get("description") or "").strip(),
                    ),
                )
                audit(self.current_user["username"], "proposal.created", "proposal", proposal_id)
                return self.send_json({"id": proposal_id}, 201)
            return self.send_error_json("Not found", 404)
        except sqlite3.IntegrityError as exc:
            return self.send_error_json(f"Məlumat düzgün deyil: {exc}", 400)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)

    def do_PATCH(self):
        path = urlparse(self.path).path
        try:
            if not self.require_auth():
                return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "bookings"] and parts[3] == "status":
                data = json_body(self)
                status = str(data.get("status") or "")
                if status not in {"Reserved", "CheckedIn", "CheckedOut", "Cancelled"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                execute(
                    "UPDATE bookings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (status, integer(parts[2])),
                )
                audit(self.current_user["username"], f"booking.{status}", "booking", parts[2])
                return self.send_json({"ok": True})
            if len(parts) == 4 and parts[:2] == ["api", "proposals"] and parts[3] == "status":
                if not self.require_auth({"Admin"}):
                    return
                data = json_body(self)
                status = str(data.get("status") or "")
                if status not in {"Təklif", "Seçildi", "İcrada", "Hazır", "Gözləyir"}:
                    return self.send_error_json("Status düzgün deyil", 400)
                execute(
                    "UPDATE proposals SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (status, integer(parts[2])),
                )
                audit(self.current_user["username"], f"proposal.{status}", "proposal", parts[2])
                return self.send_json({"ok": True})
            return self.send_error_json("Not found", 404)
        except Exception as exc:
            return self.send_error_json(str(exc), 500)


if __name__ == "__main__":
    init_db()
    port = integer(os.environ.get("PORT"), 8020)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Hotel 50 server: http://localhost:{port}")
    server.serve_forever()
