# GaadaNamanya

> Proof of concept untuk Milestone 1 Tugas Besar IF4031 Arsitektur Aplikasi Terdistribusi.

## Arsitektur

```text
BMKG Mock ──┐
           ├──> BNPB Aggregator ───> Canonical Store (PostgreSQL + JSONB)
PVMBG Mock ─┘             │
                         └──> Kafka topic: hazard-events
                                     ├──> dashboard-consumer-group ───> Dashboard Consumer
                                     └──> notification-consumer-group ─> Notification Consumer

Downstream client ─> BNPB Client API ─> Aggregator internal API
       │
       └───────────────> BNPB Auth Service (token / refresh only)
```

Aggregator melakukan polling pada service sumber, menormalisasikan ke dalam format kanonik HazardEvent, menuliskannya pada Canonical Store, dan melakukan publish kepada event. Client API memvalidasi JWT dan melakukan filtering sebelum mengembalikan data kanonik. Client API tersebut membaca data dari Aggregator dengan kredensial yang terpisah berupa `X-BNPB-Internal-Key`. Di sisi lainnya, BMKG dan PVMBG merupakan service sumber mock yang membangkitkan data untuk di-poll oleh Aggregator.

## Daftar Service
Berikut adalah daftar services yang dijalankan oleh sistem. Sebagai catatan, Anda dapat mengubah port berjalannya masing-masing service pada file konfigurasi `.env` Anda. URL yang dinyatakan disini menggunakan port default dari `.env.example`.

| Service | Folder | URL |
| --- | --- | --- |
| BMKG Mock | `services/bmkg` | `http://localhost:8081/` |
| PVMBG Mock | `services/pvmbg` | `http://localhost:8082/` |
| BNPB Aggregator | `services/bnpb-aggregator` | `http://localhost:3003/` |
| BNPB Client API | `services/bnpb-client-api` | `http://localhost:3000/` |
| BNPB Auth | `services/bnpb-auth` | `http://localhost:3001/` |
| Dashboard Consumer | `services/dashboard-consumer` | `http://localhost:3004/` |
| Notification Consumer | `services/notification-consumer` | `http://localhost:3005/` |

## Cara Menjalankan
Sebelum menjalankan sistem, pastikan Anda sudah memiliki Docker.

1. Clone repository ini ke mesin lokal Anda.
```sh
git clone https://github.com/mimiCrai/GaadaNamanya.git
cd GaadaNamanya
```

2. Buatlah sebuah file `.env` lokal menggunakan template `.env.example`. Anda dapat mengubah konfigurasi pada file tersebut.
```powershell
Copy-Item .env.example .env      # Windows

cp -p .env.example .env          # Bash
```

3. Pastikan konfigurasi Anda sudah tepat. Untuk menjalankan keseluruhan sistem, jalankan:
```sh
docker compose up -d --build
```
Cek keberjalanan setiap services dengan `docker compose ps`.

## Autentikasi dan Client API

BNPB Auth (`http://localhost:3001`) mengelola kredensial pengguna dan sesi refresh. Service ini menandatangani access token RS256 berumur pendek (secara default 60 detik) menggunakan private key miliknya; BNPB Client API hanya menerima public key milik Auth untuk keperluan verifikasi. Refresh token disimpan oleh Auth dalam bentuk hash, dirotasi setiap kali refresh, dan tidak pernah dikirimkan ke Aggregator, BMKG, maupun PVMBG.

Registrasi akan membuat pengguna dengan role `public` dan langsung mengembalikan pasangan access token dan refresh token:

```bash
curl -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"media@example.com","password":"Password123!"}'
```

Gunakan `POST /auth/login` untuk memperoleh pasangan token baru dari kredensial yang sudah ada, `POST /auth/refresh` dengan body `{ "refreshToken": "..." }` setelah access token kedaluwarsa, dan `POST /auth/logout` untuk mencabut sesi refresh. Auth juga menyediakan `GET /public-key` yang digunakan secara internal oleh Client API, serta endpoint `/admin/users` khusus administrator untuk membuat identitas `lapangan` dan `internal`.

BNPB Client API (`http://localhost:3000`) merupakan satu-satunya endpoint hazard untuk downstream. Sertakan access token dari Auth pada setiap request:

```bash
curl http://localhost:3000/hazards \
  -H 'Authorization: Bearer <access-token>'
```

`GET /hazards` menampilkan daftar hazard yang dapat dilihat, sedangkan `GET /hazards/:hazardId` mengembalikan satu hazard. Pengguna `public` menerima representasi ringkasan, sedangkan `lapangan` dan `internal` menerima representasi lengkap. Client API meneruskan correlation ID dari request ke Auth dan Aggregator, serta menggunakan `X-BNPB-Internal-Key` miliknya yang terpisah hanya untuk pemanggilan internal ke Aggregator. Client API mengembalikan `401` untuk access token yang tidak ada, tidak valid, atau kedaluwarsa, dan `502` apabila Auth atau Aggregator tidak tersedia.

## Pengujian End-to-End

Jalankan rangkaian pengujian E2E yang terisolasi dengan satu perintah setelah membuat `.env`:

```bash
bash scripts/test-e2e.sh
```

Script ini menggabungkan file Compose utama dengan `docker-compose.e2e.yml`, membangun project terisolasi `bnpb-e2e`, lalu menghapus container dan volume pengujiannya setelah selesai. Override tersebut menghapus pemetaan port ke host sehingga pengujian dapat dijalankan bersamaan dengan stack utama yang sedang berjalan. Script ini memverifikasi autentikasi API internal, ingesti awal dari kedua sumber, penolakan kredensial lintas provider, evolusi skema PVMBG, proyeksi dashboard dan notifikasi, serta gangguan PVMBG (mode error/hang) tanpa mengganggu ingesti BMKG.

## Skenario Pengujian

Jalankan perintah dari root repository menggunakan bash (pada Windows: Git Bash).

### Persiapan: helper dan token

```bash
dotenv() { grep "^$1=" .env | cut -d= -f2- | tr -d '\r'; }
json()   { sed -E "s/.*\"$1\":\"([^\"]+)\".*/\1/"; }
PW='choose-a-password'
login()  { curl -s -X POST localhost:3001/auth/login -H 'Content-Type: application/json' \
             -d "{\"email\":\"$1\",\"password\":\"$PW\"}"; }

# Media = role public 
curl -s -X POST localhost:3001/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"media@example.test\",\"password\":\"$PW\"}"
# Tim Lapangan = role lapangan, dibuat oleh administrator
docker compose exec -e ADMIN_EMAIL=admin@example.test -e ADMIN_PASSWORD="$PW" bnpb-auth npm run db:seed-admin
curl -s -X POST localhost:3001/admin/users -H "Authorization: Bearer $(login admin@example.test | json accessToken)" \
  -H 'Content-Type: application/json' -d "{\"email\":\"field@example.test\",\"password\":\"$PW\",\"role\":\"lapangan\"}"

media() { login media@example.test | json accessToken; }
field() { login field@example.test | json accessToken; }
```

Hasil yang diharapkan: register mengembalikan `201`, seed mencetak `Admin account created`, dan `/admin/users` mengembalikan `201` dengan `"role":"lapangan"`.

### P1 – Evolusi Skema

1. Baca data dari kedua provider melalui Client API (skema v1):
   ```bash
   curl -s "localhost:3000/hazards?source=BMKG" -H "Authorization: Bearer $(field)"
   curl -s "localhost:3000/hazards?source=PVMBG" -H "Authorization: Bearer $(field)" | grep -o confidence_level | wc -l
   ```
   
   Hasil yang diharapkan: hazard kanonik `SEISMIC` pada `Keterangan`; terdapat `0` hazard PVMBG yang memiliki `confidence_level`.

2. Ubah PVMBG ke skema v2:
   ```bash
   curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $(dotenv BNPB_AGGREGATOR_PVMBG_TOKEN)" \
     -H 'Content-Type: application/json' -d '{"version":2}'
   ```
   
   Hasil yang diharapkan: `{"schema_version":2,"changed_at":"..."}`; tidak ada container yang di-restart.

3. Setelah laporan PVMBG berikutnya (hingga sekitar satu menit), baca kembali:
   ```bash
   R=$(curl -s "localhost:3000/hazards?source=PVMBG" -H "Authorization: Bearer $(field)")
   echo "total: $(echo "$R" | grep -o eruption_count_24h | wc -l), with confidence_level: $(echo "$R" | grep -o confidence_level | wc -l)"
   ```

   Hasil yang diharapkan: nilai `with confidence_level` lebih dari `0` dan kurang dari `total`, di mana record baru memuatnya di dalam `attributes`, sedangkan record lama tidak berubah.

### P2 – Konkurensi & Graceful Degradation

1. Atur `PVMBG_DELAY_MIN_MS=3000` dan `PVMBG_DELAY_MAX_MS=3000` pada `.env`, buat ulang container PVMBG, lalu jalankan pembacaan khusus BMKG dan PVMBG secara bersamaan:
   ```bash
   docker compose up -d pvmbg
   bash scripts/run-source-isolation-test.sh
   ```

   Hasil yang diharapkan: `pvmbg_direct_latency` ≈ 3 detik dan threshold `bmkg_only_hazard_latency 'p(95)<300'` lolos.

2. Load test berkelanjutan (50 VU selama 60 detik):
   ```bash
   k6 run -e VUS=50 -e DURATION=60s -e ITERATION_SLEEP_SECONDS=1 tests/load/client-api.k6.js
   ```
   
   Hasil yang diharapkan: perhatikan `http_reqs` (throughput), med/p(95)/p(99) dari `client_api_hazard_latency`, `unexpected_error_rate` (threshold `< 1%`), dan `controlled_rejections` (jumlah HTTP 429).

3. Mulai gangguan PVMBG (`"mode":"error"` menjawab 503 pada Aggregator; `"mode":"hang"` tidak pernah menjawab):
   ```bash
   curl -s -X POST localhost:8082/admin/outage -H "Authorization: Bearer $(dotenv BNPB_AGGREGATOR_PVMBG_TOKEN)" \
     -H 'Content-Type: application/json' -d '{"enabled":true,"mode":"error"}'
   sleep 20
   curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' "localhost:3000/hazards?source=BMKG" -H "Authorization: Bearer $(media)" | grep -oE '"meta".*|HTTP .*'
   curl -s -w '\nHTTP %{http_code} in %{time_total}s\n' "localhost:3000/hazards?source=PVMBG" -H "Authorization: Bearer $(media)" | grep -oE '"meta".*|HTTP .*'
   ```
   
   Hasil yang diharapkan: BMKG `"status":"HEALTHY"`, PVMBG menjawab `HTTP 200` dengan cepat menggunakan data tersimpan terakhir, field `status` terisi dengan STALE dan field `staleSince` terisi.

4. Akhiri gangguan:
   ```bash
   curl -s -X POST localhost:8082/admin/outage -H "Authorization: Bearer $(dotenv BNPB_AGGREGATOR_PVMBG_TOKEN)" \
     -H 'Content-Type: application/json' -d '{"enabled":false}'
   sleep 15
   curl -s "localhost:3000/hazards?source=PVMBG" -H "Authorization: Bearer $(media)" | grep -o '"meta".*'
   ```
   
   Hasil yang diharapkan: `"status":"HEALTHY","staleSince":null` tanpa me-restart container apa pun.

### P3 – Autentikasi & Kepercayaan

1. Kredensial lintas provider:
   ```bash
   curl -s -w ' HTTP %{http_code}\n' localhost:8082/volcanic-reports -H "X-BMKG-Key: $(dotenv BNPB_AGGREGATOR_BMKG_API_KEY)"
   curl -s -w ' HTTP %{http_code}\n' localhost:8081/seismic-events -H "Authorization: Bearer $(dotenv BNPB_AGGREGATOR_PVMBG_TOKEN)"
   ```
   Hasil yang diharapkan: keduanya mengembalikan `HTTP 403` dengan `"error":"invalid_credential"`.

2. Media hanya melihat representasi ringkasan:
   ```bash
   curl -s localhost:3000/hazards -H "Authorization: Bearer $(media)" | grep -o '"Klasifikasi":"[a-z]*"' | sort | uniq -c
   ```
   Hasil yang diharapkan: hanya `"Klasifikasi":"ringkasan"` (perintah yang sama dengan `$(field)` menampilkan `"mentah"`).

3. Kedaluwarsa dan refresh token Tim Lapangan:
   ```bash
   RES=$(login field@example.test); OLD=$(echo "$RES" | json accessToken); OLD_REFRESH=$(echo "$RES" | json refreshToken)
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/hazards -H "Authorization: Bearer $OLD"
   sleep 61
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/hazards -H "Authorization: Bearer $OLD"
   NEW=$(curl -s -X POST localhost:3001/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$OLD_REFRESH\"}" | json accessToken)
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/hazards -H "Authorization: Bearer $NEW"
   curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3001/auth/refresh -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$OLD_REFRESH\"}"
   ```
   Hasil yang diharapkan: `200`, kemudian `401` untuk token yang sudah kedaluwarsa, `200` dengan token hasil refresh, dan `401` ketika refresh token yang sudah dirotasi digunakan kembali.

4. Tidak ada secret yang ter-commit:
   ```bash
   git check-ignore -v .env
   git ls-files | grep '\.env'
   ```
   Hasil yang diharapkan: `.gitignore` mengabaikan `.env`; hanya file `.env.example` yang dilacak.

### P4 – Service Independen & Penyimpanan Fleksibel

1. Hentikan, build ulang, dan jalankan kembali satu service selagi service lainnya tetap melayani:
   ```bash
   docker compose stop dashboard-consumer
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3005/api/notifications
   curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/hazards -H "Authorization: Bearer $(media)"
   docker compose up -d --build --no-deps dashboard-consumer
   ```
   Hasil yang diharapkan: kedua request mengembalikan `200`; hanya `dashboard-consumer` yang di-build ulang dan di-restart (`docker compose ps`).

2. Record PVMBG sebelum dan sesudah adanya `confidence_level`, berdampingan dalam satu tabel:
   ```bash
   docker compose exec canonical-store psql -U "$(dotenv CANONICAL_STORE_DB_USER)" -d "$(dotenv CANONICAL_STORE_DB_NAME)" -c \
     "SELECT source_ref_id, attributes ? 'confidence_level' AS v2, attributes FROM hazard_events WHERE source = 'PVMBG' ORDER BY ingested_at DESC LIMIT 6;"
   ```
   Hasil yang diharapkan: baris dengan `v2 = t` dan `v2 = f` berada pada kolom JSONB `attributes` yang sama, tanpa melibatkan migrasi.\
   Catatan: Pastikan untuk menjalankan ini secepatnya setelah mengubah skema, karena data dengan `v2 = f` akan tenggelam apabila terlalu dibiarkan terlalu lama.

3. Hanya Aggregator yang dikonfigurasi untuk dapat mengakses Canonical Store:
   ```bash
   for s in bnpb-aggregator bnpb-client-api bnpb-auth dashboard-consumer notification-consumer bmkg pvmbg; do
     echo "$s -> $(docker compose exec -T "$s" printenv DATABASE_URL | grep -o '@[^/]*' || echo 'no DATABASE_URL')"
   done
   ```
   Hasil yang diharapkan: hanya `bnpb-aggregator -> @canonical-store:5432`; Client API tidak memiliki database, dan setiap service lainnya mengarah ke store miliknya sendiri.

### P5 – Pub/Sub Fan-out

1. Kedua consumer menerima event yang sama:
   ```bash
   docker compose logs dashboard-consumer | grep -m1 eventId
   docker compose logs dashboard-consumer notification-consumer | grep <eventId>
   ```
   Hasil yang diharapkan: `eventId` yang sama muncul satu kali pada log masing-masing consumer.

2. Downtime consumer dan catch-up:
   ```bash
   docker compose stop dashboard-consumer
   docker compose logs -f --since 1m notification-consumer
   docker compose exec kafka kafka-consumer-groups --bootstrap-server "$(dotenv KAFKA_INTERNAL_BOOTSTRAP_SERVER)" \
     --describe --group "$(dotenv DASHBOARD_CONSUMER_KAFKA_GROUP_ID)"
   docker compose start dashboard-consumer
   ```
   Hasil yang diharapkan: `LAG` bernilai di atas `0` selama consumer dihentikan; setelah dijalankan kembali, dashboard mencatat log `Updated dashboard projection` untuk event yang terlewat, dan perintah `kafka-consumer-groups` yang sama menunjukkan `LAG 0`.

3. Consumer group baru, tanpa menyentuh producer:
   ```bash
   docker compose exec kafka kafka-console-consumer --bootstrap-server "$(dotenv KAFKA_INTERNAL_BOOTSTRAP_SERVER)" \
     --topic "$(dotenv BNPB_AGGREGATOR_KAFKA_TOPIC)" --group demo-third-consumer-group --from-beginning --max-messages 3
   ```
   Hasil yang diharapkan: tiga event `hazard.created`/`hazard.updated`; `kafka-consumer-groups --bootstrap-server "$(dotenv KAFKA_INTERNAL_BOOTSTRAP_SERVER)" --list` kini juga menampilkan `demo-third-consumer-group`.

Catatan: Anda dapat melacak satu alur berdasarkan correlation ID-nya (dikembalikan sebagai response header `X-Correlation-ID`): `docker compose logs <svc> | grep <correlation_id>`.

## Daftar Variabel Konfigurasi

Berikut adalah daftar variabel konfigurasi yang digunakan pada file `.env`. Nilai default untuk setiap variabel dapat dilihat pada `.env.example`.

```env
# Canonical Store (PostgreSQL)
CANONICAL_STORE_DB_USER=
CANONICAL_STORE_DB_PASSWORD=
CANONICAL_STORE_DB_NAME=

# Auth Store (PostgreSQL; digunakan oleh bnpb-auth)
AUTH_STORE_DB_USER=
AUTH_STORE_DB_PASSWORD=
AUTH_STORE_DB_NAME=
BNPB_AUTH_HOST_PORT=
BNPB_CLIENT_API_HOST_PORT=

# BNPB Auth
BNPB_AUTH_JWT_PRIVATE_KEY=
BNPB_AUTH_JWT_ACCESS_TTL_SECONDS=
BNPB_AUTH_JWT_REFRESH_TTL_SECONDS=

# Kafka broker
KAFKA_NODE_ID=
KAFKA_PROCESS_ROLES=
KAFKA_CONTROLLER_QUORUM_VOTERS=
KAFKA_LISTENERS=
KAFKA_ADVERTISED_LISTENERS=
KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=
KAFKA_INTER_BROKER_LISTENER_NAME=
KAFKA_CONTROLLER_LISTENER_NAMES=
KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=
KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=
KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=
KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=
KAFKA_AUTO_CREATE_TOPICS_ENABLE=
KAFKA_CLUSTER_ID=
KAFKA_HOST_PORT=
KAFKA_INTERNAL_BOOTSTRAP_SERVER=

# BNPB Aggregator
BNPB_AGGREGATOR_HOST_PORT=
BNPB_AGGREGATOR_CONTAINER_PORT=
BNPB_AGGREGATOR_SERVICE_NAME=
BNPB_AGGREGATOR_NODE_ENV=
BNPB_AGGREGATOR_DATABASE_URL=
BNPB_AGGREGATOR_KAFKA_BROKERS=
BNPB_AGGREGATOR_KAFKA_CLIENT_ID=
BNPB_AGGREGATOR_KAFKA_TOPIC=
BNPB_AGGREGATOR_INTERNAL_API_KEY=
BNPB_AGGREGATOR_BMKG_BASE_URL=
BNPB_AGGREGATOR_BMKG_API_KEY=
BNPB_AGGREGATOR_BMKG_REQUEST_TIMEOUT_MS=
BNPB_AGGREGATOR_PVMBG_BASE_URL=
BNPB_AGGREGATOR_PVMBG_TOKEN=
BNPB_AGGREGATOR_PVMBG_REQUEST_TIMEOUT_MS=
BNPB_AGGREGATOR_POLL_INTERVAL_MS=
BNPB_AGGREGATOR_POLL_OVERLAP_MS=
BNPB_AGGREGATOR_OUTBOX_RELAY_INTERVAL_MS=
BNPB_AGGREGATOR_OUTBOX_BATCH_SIZE=

# Dashboard Consumer
DASHBOARD_STORE_DB_USER=
DASHBOARD_STORE_DB_PASSWORD=
DASHBOARD_STORE_DB_NAME=
DASHBOARD_CONSUMER_HOST_PORT=
DASHBOARD_CONSUMER_CONTAINER_PORT=
DASHBOARD_CONSUMER_SERVICE_NAME=
DASHBOARD_CONSUMER_NODE_ENV=
DASHBOARD_CONSUMER_DATABASE_URL=
DASHBOARD_CONSUMER_KAFKA_BROKERS=
DASHBOARD_CONSUMER_KAFKA_CLIENT_ID=
DASHBOARD_CONSUMER_KAFKA_GROUP_ID=
DASHBOARD_CONSUMER_KAFKA_TOPIC=

# Notification Consumer
NOTIFICATION_STORE_DB_USER=
NOTIFICATION_STORE_DB_PASSWORD=
NOTIFICATION_STORE_DB_NAME=
NOTIFICATION_CONSUMER_HOST_PORT=
NOTIFICATION_CONSUMER_CONTAINER_PORT=
NOTIFICATION_CONSUMER_SERVICE_NAME=
NOTIFICATION_CONSUMER_NODE_ENV=
NOTIFICATION_CONSUMER_DATABASE_URL=
NOTIFICATION_CONSUMER_KAFKA_BROKERS=
NOTIFICATION_CONSUMER_KAFKA_CLIENT_ID=
NOTIFICATION_CONSUMER_KAFKA_GROUP_ID=
NOTIFICATION_CONSUMER_KAFKA_TOPIC=

# BMKG Mock
BMKG_PORT=
BMKG_NODE_ENV=
BMKG_LOG_LEVEL=
BMKG_STORE_DB_USER=
BMKG_STORE_DB_PASSWORD=
BMKG_STORE_DB_NAME=
BMKG_DATABASE_URL=
BMKG_API_KEYS=
BMKG_DELAY_MIN_MS=
BMKG_DELAY_MAX_MS=
BMKG_EVENT_INTERVAL_MS=
BMKG_EVENT_GENERATION_PROBABILITY=
BMKG_WARNING_LAG_MS=
BMKG_RANDOM_SEED=

# PVMBG Mock
PVMBG_PORT=
PVMBG_NODE_ENV=
PVMBG_LOG_LEVEL=
PVMBG_STORE_DB_USER=
PVMBG_STORE_DB_PASSWORD=
PVMBG_STORE_DB_NAME=
PVMBG_DATABASE_URL=
PVMBG_CLIENT_TOKENS=
PVMBG_DELAY_MIN_MS=
PVMBG_DELAY_MAX_MS=
PVMBG_REPORT_INTERVAL_MS=
PVMBG_REPORT_GENERATION_PROBABILITY=
PVMBG_RANDOM_SEED=
```
