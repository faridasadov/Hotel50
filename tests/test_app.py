import base64
import http.client
import json
import sys
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app as hotel_app


class Hotel50ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        root = Path(cls._tmpdir.name)
        hotel_app.DB_PATH = root / "test.db"
        hotel_app.BACKUP_DIR = root / "backups"
        hotel_app.LOGIN_ATTEMPTS.clear()
        hotel_app.init_db()

        cls.server = hotel_app.ThreadingHTTPServer(("127.0.0.1", 0), hotel_app.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls._tmpdir.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None
        req_headers = dict(headers or {})
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            req_headers.setdefault("Content-Type", "application/json")
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, path, body=body, headers=req_headers)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, dict(res.getheaders()), data

    def header(self, headers, name):
        lower = name.lower()
        for key, value in headers.items():
            if key.lower() == lower:
                return value
        return ""

    def login(self, username, password):
        status, headers, data = self.request("POST", "/api/auth/login", {
            "username": username,
            "password": password,
        })
        self.assertEqual(status, 200, data.decode("utf-8"))
        cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
        self.assertTrue(cookie)
        return {"Cookie": cookie}

    def test_static_entry_routes_are_separated(self):
        status, headers, data = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", self.header(headers, "Content-Type"))
        body = data.decode("utf-8")
        self.assertIn("Hotel 50 — Xankəndi", body)
        self.assertIn('id="roomsGrid"', body)
        self.assertIn('href="request.html"', body)
        self.assertNotIn('id="loginForm"', body)

        status, headers, data = self.request("GET", "/app.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", self.header(headers, "Content-Type"))
        app_body = data.decode("utf-8")
        self.assertIn('id="loginForm"', app_body)
        self.assertIn("Sorğu səhifəsini aç", app_body)

        status, headers, data = self.request("GET", "/request.html")
        self.assertEqual(status, 200)
        self.assertIn("text/html", self.header(headers, "Content-Type"))
        self.assertIn("Rezervasiya<br>Sorğusu", data.decode("utf-8"))

    def test_public_booking_request_works_without_auth(self):
        status, _, data = self.request("POST", "/api/public/booking-requests", {
            "full_name": "Public Guest",
            "phone": "+994501112233",
            "check_in": "2026-06-10",
            "check_out": "2026-06-12",
            "people_count": 2,
            "note": "window side",
            "room_category": "Deluxe",
        })
        self.assertEqual(status, 201, data.decode("utf-8"))
        request_id = json.loads(data)["id"]

        reception = self.login("reception", "reception123")
        status, _, data = self.request("GET", "/api/booking-requests", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        request_row = next(item for item in json.loads(data) if item["id"] == request_id)
        self.assertEqual(request_row["room_category"], "Deluxe")

    def test_category_rename_updates_existing_rooms(self):
        admin = self.login("admin", "admin123")

        status, _, data = self.request("POST", "/api/room-categories", {
            "name": "Test Deluxe",
            "description": "rename candidate",
            "base_price": 99,
            "amenities": ["wifi"],
        }, headers=admin)
        self.assertEqual(status, 201, data.decode("utf-8"))
        cat_id = json.loads(data)["id"]

        status, _, data = self.request("POST", "/api/rooms", {
            "number": "999",
            "floor": 9,
            "room_type": "Test Deluxe",
            "capacity": 2,
            "nightly_rate": 99,
            "note": "",
        }, headers=admin)
        self.assertEqual(status, 201, data.decode("utf-8"))
        room_id = json.loads(data)["id"]

        status, _, data = self.request("PUT", f"/api/room-categories/{cat_id}", {
            "name": "Test Premium",
            "description": "renamed",
            "base_price": 109,
            "amenities": ["wifi", "tv"],
        }, headers=admin)
        self.assertEqual(status, 200, data.decode("utf-8"))

        status, _, data = self.request("GET", "/api/rooms", headers=admin)
        self.assertEqual(status, 200, data.decode("utf-8"))
        room_row = next(item for item in json.loads(data) if item["id"] == room_id)
        self.assertEqual(room_row["room_type"], "Test Premium")

    def test_request_status_tracks_handler(self):
        status, _, data = self.request("POST", "/api/public/booking-requests", {
            "full_name": "Request Guest",
            "phone": "+994501234567",
            "check_in": "2026-06-15",
            "check_out": "2026-06-16",
            "people_count": 1,
            "note": "",
        })
        self.assertEqual(status, 201, data.decode("utf-8"))
        request_id = json.loads(data)["id"]

        reception = self.login("reception", "reception123")
        status, _, data = self.request("PATCH", f"/api/booking-requests/{request_id}/status", {
            "status": "Təsdiq",
        }, headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))

        status, _, data = self.request("GET", "/api/booking-requests", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        request_row = next(item for item in json.loads(data) if item["id"] == request_id)
        self.assertEqual(request_row["status"], "Təsdiq")
        self.assertEqual(request_row["handled_by"], "reception")
        self.assertTrue(request_row["handled_at"])

    def test_request_can_convert_to_booking(self):
        status, _, data = self.request("POST", "/api/public/booking-requests", {
            "full_name": "Convert Guest",
            "phone": "+994509998877",
            "check_in": "2026-06-20",
            "check_out": "2026-06-22",
            "people_count": 1,
            "note": "late arrival",
        })
        self.assertEqual(status, 201, data.decode("utf-8"))
        request_id = json.loads(data)["id"]

        reception = self.login("reception", "reception123")
        status, _, data = self.request("POST", f"/api/booking-requests/{request_id}/convert", {
            "room_id": 1,
            "status": "Reserved",
            "check_in": "2026-06-20",
            "check_out": "2026-06-22",
            "people_count": 1,
            "note": "late arrival",
        }, headers=reception)
        self.assertEqual(status, 201, data.decode("utf-8"))
        result = json.loads(data)
        self.assertTrue(result["guest_id"])
        self.assertTrue(result["booking_id"])

        status, _, data = self.request("GET", "/api/bookings", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        booking = next(item for item in json.loads(data) if item["id"] == result["booking_id"])
        self.assertEqual(booking["guest_name"], "Convert Guest")
        self.assertEqual(booking["status"], "Reserved")

        status, _, data = self.request("GET", "/api/booking-requests", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        request_row = next(item for item in json.loads(data) if item["id"] == request_id)
        self.assertEqual(request_row["status"], "Təsdiq")
        self.assertEqual(request_row["handled_by"], "reception")

    def test_role_permissions_are_separated(self):
        reception = self.login("reception", "reception123")
        accounting = self.login("accounting", "accounting123")

        status, _, _ = self.request("GET", "/api/bookings", headers=reception)
        self.assertEqual(status, 200)

        status, _, _ = self.request("GET", "/api/payments", headers=reception)
        self.assertEqual(status, 403)

        status, _, _ = self.request("GET", "/api/payments", headers=accounting)
        self.assertEqual(status, 200)

        status, _, _ = self.request("GET", "/api/bookings", headers=accounting)
        self.assertEqual(status, 200)

    def test_document_upload_roundtrip(self):
        reception = self.login("reception", "reception123")
        status, _, data = self.request("POST", "/api/guests", {
            "full_name": "Upload Guest",
            "phone": "+994500000000",
            "document_no": "AA1234567",
            "note": "",
        }, headers=reception)
        self.assertEqual(status, 201, data.decode("utf-8"))
        guest_id = json.loads(data)["id"]

        payload = base64.b64encode(b"fake-pdf-content").decode("ascii")
        status, _, data = self.request("POST", f"/api/guests/{guest_id}/documents", {
            "title": "Passport",
            "file_name": "passport.pdf",
            "content_type": "application/pdf",
            "data_base64": payload,
        }, headers=reception)
        self.assertEqual(status, 201, data.decode("utf-8"))
        doc_id = json.loads(data)["id"]

        status, headers, data = self.request("GET", f"/api/documents/{doc_id}", headers=reception)
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "application/pdf")
        self.assertEqual(data, b"fake-pdf-content")

    def test_checkout_auto_calculates_late_fee_and_only_admin_can_clear(self):
        reception = self.login("reception", "reception123")
        accounting = self.login("accounting", "accounting123")
        admin = self.login("admin", "admin123")

        status, _, data = self.request("POST", "/api/guests", {
            "full_name": "Late Checkout Guest",
            "phone": "+994507777777",
            "document_no": "BB1234567",
            "note": "",
        }, headers=reception)
        self.assertEqual(status, 201, data.decode("utf-8"))
        guest_id = json.loads(data)["id"]

        status, _, data = self.request("POST", "/api/bookings", {
            "guest_id": guest_id,
            "room_id": 1,
            "check_in": "2026-06-07",
            "check_out": "2026-06-08",
            "status": "CheckedIn",
            "people_count": 1,
            "total_amount": 45,
            "note": "",
        }, headers=reception)
        self.assertEqual(status, 201, data.decode("utf-8"))
        booking_id = json.loads(data)["id"]

        original_now = hotel_app.current_local_time
        hotel_app.current_local_time = lambda: datetime(2026, 6, 8, 15, 30, 0)
        try:
            status, _, data = self.request("PATCH", f"/api/bookings/{booking_id}/status", {
                "status": "CheckedOut",
            }, headers=reception)
            self.assertEqual(status, 200, data.decode("utf-8"))
        finally:
            hotel_app.current_local_time = original_now

        status, _, data = self.request("GET", "/api/bookings", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        booking = next(item for item in json.loads(data) if item["id"] == booking_id)
        self.assertEqual(booking["status"], "CheckedOut")
        self.assertEqual(booking["late_fee"], 7.5)

        status, _, _ = self.request("PATCH", f"/api/bookings/{booking_id}/late-fee", {
            "late_fee": 0,
        }, headers=accounting)
        self.assertEqual(status, 403)

        status, _, data = self.request("PATCH", f"/api/bookings/{booking_id}/late-fee", {
            "late_fee": 0,
        }, headers=admin)
        self.assertEqual(status, 200, data.decode("utf-8"))

        status, _, data = self.request("GET", "/api/bookings", headers=reception)
        self.assertEqual(status, 200, data.decode("utf-8"))
        booking = next(item for item in json.loads(data) if item["id"] == booking_id)
        self.assertEqual(booking["late_fee"], 0)


if __name__ == "__main__":
    unittest.main()
