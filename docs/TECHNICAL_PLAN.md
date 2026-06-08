# 50 nəfərlik hotel proqramı - texniki plan

## Məqsəd
50 nəfərlik kiçik hotel/hostel üçün lokal və ya serverdə işləyən idarəetmə sistemi qurmaq.
Birinci mərhələdə resepsion işləri, otaq doluluğu, bronlar, qonaq qeydiyyatı və ödəniş izləməyi həll edirik.

## İstifadəçi rolları
- Admin: bütün məlumatları görür, otaqları və istifadəçiləri idarə edir.
- Resepsion: bron, check-in, check-out, ödəniş və qonaq məlumatlarını idarə edir.
- Mühasibat: ödəniş, borc və gəlir hesabatlarına baxır.

## MVP funksiyaları
- Dashboard: dolu/boş yataq sayı, aktiv qonaqlar, bu gün giriş/çıxışlar, borc məbləği.
- Otaqlar: otaq nömrəsi, mərtəbə, tutum, tip, gecəlik qiymət, status.
- Qonaqlar: ad, telefon, sənəd nömrəsi, qeyd.
- Bronlar: qonaq, otaq, giriş tarixi, çıxış tarixi, status.
- Check-in / check-out: bron statusunun dəyişməsi və otaq doluluğunun yenilənməsi.
- Ödənişlər: bron üzrə məbləğ, metod, tarix, qeyd.
- Xərclər: kommunal, təmir, təmizlik, ərzaq və digər xərclər.
- Hesabat: aktiv qalma, ödənilən məbləğ, qalıq borc.
- Otaq təqvimi, borclular, sənədlər, qəbz, online sorğu və backup restore.

## Sonrakı mərhələlər
- Login və istifadəçi rolları.
- Xərc modulu: kommunal, təmir, təmizlik və digər xərclər.
- Təmizlik və texniki servis tapşırıqları.
- Müştəri müqaviləsi və qəbz PDF çıxarışı.
- Excel/CSV export.
- Online bron forması.
- Backup və audit log.

## Texniki seçim
- Backend: Python standard library HTTP server.
- Database: SQLite.
- Frontend: Vanilla HTML, CSS, JavaScript.
- Üstünlük: əlavə paket quraşdırmadan işləyir, kiçik hotel üçün sadə deploy olunur.

## Database modeli
- rooms: otaq və tutum məlumatları.
- guests: qonaq məlumatları.
- bookings: qalma dövrü və status.
- payments: bron üzrə ödənişlər.
- expenses: hotel xərcləri.
- users: sistem istifadəçiləri və rollar.
- audit_logs: əsas əməliyyatların izi.
- guest_documents: qonaq sənədləri.
- booking_requests: online rezervasiya sorğuları.

## Status qaydaları
- booking status:
  - Reserved: bron var, hələ giriş etməyib.
  - CheckedIn: qonaq hazırda hoteldədir.
  - CheckedOut: qonaq çıxış edib.
  - Cancelled: bron ləğv edilib.
- room status hesablanır:
  - boş yataq = room.capacity - aktiv CheckedIn bron sayı.

## API
- POST /api/auth/login
- POST /api/auth/logout
- GET /api/auth/session
- GET /api/summary
- GET /api/rooms
- POST /api/rooms
- GET /api/guests
- POST /api/guests
- GET /api/bookings
- POST /api/bookings
- PATCH /api/bookings/:id/status
- GET /api/payments
- POST /api/payments
- GET /api/expenses
- POST /api/expenses
- GET /api/users
- POST /api/users
- GET /api/audit
- GET /api/calendar
- GET /api/debtors
- GET /api/reminders
- GET /api/export/monthly
- GET /api/receipts/:id
- GET /api/documents
- POST /api/guests/:id/documents
- GET /api/booking-requests
- POST /api/public/booking-requests
- PATCH /api/booking-requests/:id/status
- GET /api/backups
- DELETE /api/backups/:name
- POST /api/backups/delete
- POST /api/restore
- GET /api/backup

## İlk iş planı
1. Layihə skeleti və texniki plan.
2. SQLite schema və seed otaqlar.
3. REST API.
4. Dashboard və əsas formalar.
5. Lokal test və server URL.
