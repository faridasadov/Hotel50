# Hotel 50

50 nəfərlik kiçik hotel üçün sadə idarəetmə sistemi.

## İşə salmaq

```bash
cd /root/github-projects/hotel-50
python3 app.py
```

Sonra brauzerdə açın:

```text
http://localhost:8020
```

## Hazır olanlar

- Admin giriş: `admin` / `admin123`.
- Rol sistemi: `Admin`, `Reception`, `Accounting`.
- 25 otaq / 50 yataq seed olunur.
- Dashboard.
- Otaq, qonaq, bron və ödəniş CRUD başlanğıcı.
- Xərc modulu və aylıq gəlir/xərc/net göstəriciləri.
- Təkliflər siyahısı: bundan sonrakı işləri seçmək və statusunu izləmək.
- Check-in, check-out, ləğv statusları.
- Backup düyməsi və `/api/backup` endpoint-i.
- SQLite database: `hotel50.db`.

## Test istifadəçiləri

```text
admin / admin123
reception / reception123
accounting / accounting123
```

## Plan

Ətraflı texniki plan: `docs/TECHNICAL_PLAN.md`.
