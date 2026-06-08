import base64
import http.client
import json
import sys
import tempfile
import threading
import unittest
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

    def login(self, username, password):
        status, headers, data = self.request("POST", "/api/auth/login", {
            "username": username,
            "password": password,
        })
        self.assertEqual(status, 200, data.decode("utf-8"))
        cookie = headers.get("Set-Cookie", "").split(";", 1)[0]
        self.assertTrue(cookie)
        return {"Cookie": cookie}

    def test_public_booking_request_works_without_auth(self):
        status, _, data = self.request("POST", "/api/public/booking-requests", {
            "full_name": "Public Guest",
            "phone": "+994501112233",
            "check_in": "2026-06-10",
            "check_out": "2026-06-12",
            "people_count": 2,
            "note": "window side",
        })
        self.assertEqual(status, 201, data.decode("utf-8"))

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
        self.assertEqual(status, 403)

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


if __name__ == "__main__":
    unittest.main()
