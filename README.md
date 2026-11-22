# GaadaNamanya

> Proof of concept untuk Milestone 1 Tugas Besar IF4031 Arsitektur Aplikasi Terdistribusi.

## Arsitektur

```text
BMKG Mock ──┐
           ├──> BNPB Aggregator ───> Canonical Store (MongoDB sharded cluster)
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
| Sensor Pantai | Image resmi asisten | `http://localhost:8083/healthz` |
| BNPB Aggregator | `services/bnpb-aggregator` | `http://localhost:3003/` |
| BNPB Client API | `services/bnpb-client-api` | `http://localhost:3000/` |
| BNPB Auth | `services/bnpb-auth` | `http://localhost:3001/` |
| Dashboard Consumer | `services/dashboard-consumer` | `http://localhost:3004/` |
| Notification Consumer | `services/notification-consumer` | `http://localhost:3005/` |
| Field Report Processor | `services/field-report-processor` | `http://localhost:3007/health` |
| Fire Processor | `services/fire-processor` | `http://localhost:3008/health` |

## Deployment demo Kubernetes

Demo wajib menggunakan node dengan kernel terpisah. Entry point full-stack memerlukan **enam node yang dapat menjadwalkan Pod**, dibagi menjadi dua kelompok shard yang tidak beririsan, masing-masing tiga salinan data. Contoh: satu VM K3s server sekaligus worker dan lima VM K3s agent. Setiap node hanya menyimpan satu shard sehingga salinan replika tidak membuat seluruh dataset berada pada satu node. Cluster berbasis container seperti Docker Desktop kind hanya untuk pengembangan.

Setelah cluster dan kubeconfig siap, salin `k8s/full-stack.json.example` menjadi `k8s/full-stack.json` dan isi image registry; batas memori `resources.requests`/`resources.limits` sesuai Lampiran B sudah tersedia di contoh. Jalankan `python3 scripts/kubernetes/init-secrets.py` sekali untuk membuat `.env.k8s` dengan kredensial acak. Login ke image registry, kemudian jalankan **satu perintah deployment** dari root repositori:

```bash
KUBE_CONTEXT=bnpb-demo bash scripts/kubernetes/deploy-all.sh
```

Perintah ini membangun dan mengirim image, membuat Secret dan ConfigMap, menjalankan seluruh storage, Kafka, sumber data, dan layanan BNPB, lalu memverifikasi MongoDB serta isolasi akses storage dengan NetworkPolicy. Panduan persiapan VM/K3s, konfigurasi, NodePort, dan pemeriksaan hasil ada di [deployment Kubernetes](docs/kubernetes-deployment.md).

Namespace aplikasi wajib `sistem-informasi-kebencanaan-bnpb`. Isi context eksplisit dan hostname keenam node di konfigurasi. Setup dari awal, topologi/host, seluruh langkah pengujian, expected result, troubleshooting, dan pengumpulan bukti tersedia di **[petunjuk.md](petunjuk.md)**. Hasil audit beserta kriteria yang masih gagal atau belum diuji ada di [matriks penerimaan](docs/audit-instructions.md). Cluster lokal Docker Desktop tidak membuktikan kepatuhan demo. Pemulihan otomatis disk/node permanen serta observabilitas menyeluruh masih perlu diselesaikan sebelum seluruh kriteria dapat dinyatakan lulus.

## Pengembangan lokal dengan Docker Compose

Sebelum menjalankan sistem lokal, pastikan Anda sudah memiliki Docker.

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

Canonical Store menggunakan MongoDB dengan dua shard (masing-masing tiga replica), tiga config server, dan router `canonical-store`. Bootstrap replica set/user dan service migration `canonical-store-migrate` berjalan otomatis; Aggregator menunggu migration selesai. Migration berversi membuat collection, sharding, index, dan seed, lalu mencatatnya di `schema_migrations`. Lihat [detail MongoDB dan transactional outbox](docs/mongodb-canonical-store.md). Data Canonical Store PostgreSQL lama tidak dihapus, tetapi tidak diimpor otomatis ke MongoDB; sumber BMKG/PVMBG akan dipoll ulang dengan checkpoint MongoDB yang baru.

Audit API M2 tersedia melalui `GET /internal/audit/events`, `/internal/audit/checksum`, dan `/internal/audit/location`, memakai `Authorization: Bearer <BNPB_AGGREGATOR_AUDIT_TOKEN>`. Events mendukung `source`, `since`, `limit`, serta cursor; pembacaan storage yang tidak lengkap ditandai `partial` dan `unavailable_units`. Endpoint `/internal/hazards?limit=50` juga mendukung pagination lintas shard. Lihat [kontrak, konfigurasi, dan pengujian Audit API](docs/bnpb-audit-api.md).

`docker compose up -d --build` langsung menjalankan tiga Aggregator di belakang HAProxy. Ketiganya melayani REST, sementara polling dan relay memakai satu lease MongoDB dengan fencing pada setiap transaksi background. Uji otomatis failover, clock skew, dan freeze/resume tersedia melalui `bash scripts/test-aggregator-failover.sh`. Lihat [detail koordinasi Aggregator](docs/bnpb-aggregator-leadership.md), termasuk batas pengujian Compose sebelum deployment Kubernetes.

Suite load test Aggregator P2 tersedia melalui `bash scripts/run-aggregator-load-test.sh smoke`. Mode `sustained`, `scaling`, `benchmark`, dan `rolling` menyiapkan pengukuran 10.000 VU, scaling 3→5→2, throughput 1 vs 3 instance, serta rolling update. Lihat [panduan load test P2](docs/aggregator-load-testing.md) untuk konfigurasi Compose/Kubernetes dan batas pembuktiannya.

Sensor Pantai M2 dijalankan dari image resmi pada `http://localhost:8083`. Aggregator membaca station/observation dengan cursor dan circuit breaker, menyimpan hazard COASTAL atau karantina data rusak, serta meneruskan event kritis ke notifikasi. Gunakan `bash scripts/test-sensor-pantai.sh` untuk pengujian otomatis; lihat [integrasi Sensor Pantai](docs/sensor-pantai.md).

### Pengukuran end-to-end Sensor Pantai (P5)

Tester Agent menjalankan gangguan dan tidak membaca data aplikasi. Pengukuran jalur Sensor Pantai → Canonical Store → inbox notifikasi dilakukan oleh skrip kelompok pada satu mesin, memakai jam monotonik. Setelah stack berjalan, jalankan skrip ini sebelum memulai skenario gangguan:

```bash
bash scripts/sensor-pantai/measure-e2e.sh --duration-seconds 300 --drain-seconds 15
```

Skrip memuat kredensial dan port dari `.env`, membaca baseline sekali, lalu melakukan warm-up pada halaman terakhir sebelum memulai pengukuran. Polling berikutnya memakai cursor dengan overlap halaman terakhir, sehingga biaya pembacaan tidak mengikuti panjang riwayat. Scan berhenti pada halaman yang lebih pendek dari limit 1000, meskipun cursor live feed tetap tersedia. Sampling inbox berjalan independen dari sumber; Audit API dan inbox hanya dibaca saat ada event kritis yang masih perlu dikonfirmasi.

Di akhir, skrip memverifikasi seluruh riwayat sekali sementara sampling tetap berjalan. Event yang dilewatkan cursor atau kedatangan di luar urutan membuat hasil `inconclusive`; event tersebut tidak diabaikan. Verifikasi ini dapat memperpanjang collection; `collectionMs` melaporkan durasi aktual. Tambahan request Sensor Pantai dibatasi satu antrean bersama (default maksimal 2 request/detik), termasuk verifikasi, dan kegagalan memakai cooldown. Request ditandai `User-Agent: bnpb-p5-observer`; penghitung `requests.sensor` pada laporan adalah trafik observer yang tetap harus diperhitungkan saat membuktikan P5 kriteria 4.

Override `--sensor-url`, `--aggregator-url`, dan `--notification-url` dapat digunakan untuk endpoint atau port-forward Kubernetes. Skrip hanya membaca API; tidak mengubah Tester Agent maupun aplikasi. API inbox saat ini masih mengembalikan seluruh isi; respons di atas 16 MiB membuat pengukuran `inconclusive`, bukan dianggap lengkap.

- Hasil JSON: `test-results/sensor-pantai/measurement.json`. Berisi jumlah event kritis valid yang baru terlihat, jumlah diterima/belum diterima setelah drain, sampel, serta rentang p95.
- Titik awal paling konservatif adalah awal pembacaan tail sebelumnya; batas akhir adalah saat inbox terbaca. Scan baseline tidak masuk ke waktu ukur. Cursor diasumsikan mempertahankan posisi untuk penambahan berurutan; pemeriksaan akhir mencegah event yang terlewat cursor menghasilkan kelulusan palsu. Timestamp virtual sumber dan jam node aplikasi tidak dipakai untuk menghitung latensi.
- `pass` hanya diberikan bila semua event pada cohort teramati diterima dan batas atas p95 ≤5 detik. `fail` berarti ada event yang belum diterima setelah drain atau batas bawah p95 >5 detik. Hasil `inconclusive` mencakup tidak adanya event baru, data parsial/tidak konsisten, endpoint masih bermasalah, atau rentang sampling yang melintasi batas 5 detik. Exit code masing-masing adalah `0`, `1`, dan `2`.
- Error budget P5: kehilangan yang diizinkan `0`; keterlambatan >5 detik diizinkan maksimal `floor(5% × jumlah event)`. Laporan menunjukkan keterlambatan pasti/mungkin, rentang sisa budget, dan status budget `within`, `exceeded`, atau `uncertain` agar ketidakpastian sampling tidak dianggap sebagai pelanggaran pasti. Tanpa event baru, status budget adalah `not_measured`.
- Bukti berlaku untuk ID baru yang valid dan diekspos API selama collection. Pengukuran mengasumsikan pagination sumber konsisten serta history dan ID stabil. Event internal vendor yang tidak pernah diekspos tidak bisa dihitung. Source clock mundur, history menyusut, ID berubah, dan data yang tertinggal dari jam sumber ditandai sebagai masalah pengukuran. Simpan hasil bersama waktu/skenario game day; jangan menyebut hasil sampling sebagai timestamp emisi vendor yang eksak.

Pengujian pengukur: `node --test scripts/sensor-pantai/measurement.test.mjs`.

## Observabilitas

Jalankan `bash scripts/start-observability.sh` untuk menambahkan Prometheus, Grafana, OpenTelemetry Collector, dan Tempo ke stack. Grafana tersedia di `http://localhost:3006`, dengan dashboard **BNPB → BNPB Overview** dan pencarian trace melalui **Explore → Tempo**. Port, akun Grafana, dan sampling trace tersedia pada bagian monitoring di `.env.example`; nilai default juga berlaku untuk `.env` lama.

Ketujuh service menyediakan `/metrics`. Dashboard menampilkan throughput, error, dan p95 HTTP, pemrosesan consumer, DLQ/satelit, serta indikator P2/P5 berikut:

- Leader Aggregator, perubahan leadership, dan penolakan fencing Mongo/Kafka.
- Jumlah request, p95 HTTP, circuit breaker, dan source lag Sensor Pantai. Status circuit hanya ditampilkan dari leader: `0` closed, `1` open, `2` probing.
- p95 pemrosesan lokal notifikasi kritis, dari awal handler sampai inbox berhasil commit, memakai jam monotonik `performance.now()`. Pergeseran jam node tidak mengubah durasi atau membuang sampel. Duplikat dan transaksi gagal tidak dihitung. Target end-to-end P5 ≤5 detik diukur dengan [skrip pengukur kelompok](scripts/sensor-pantai/measure-e2e.sh); histogram lokal ini tidak mengklaim mengukur target tersebut.
- HTTP 503 pada endpoint hazard menurut role, untuk melihat penolakan saat overload. Angka ini juga mencakup 503 akibat ketidaktersediaan downstream, sehingga bukan penghitung eksklusif admission control.

HTTP dan database di-trace otomatis; context polling BMKG/PVMBG/Sensor Pantai diteruskan melalui outbox dan Kafka ke consumer. Log menambahkan `traceId` dan `spanId` selama span aktif pada correlation ID yang sudah ada. Cari span `source.poll` di Tempo, lalu filter atribut `source.stream=SENSOR_PANTAI` untuk jalur sensor. Overlay tidak mengubah `NODE_ENV`, ukuran connection pool, atau format log service, sehingga konfigurasi runtime tetap sebanding dengan stack tanpa observabilitas.

Gunakan `bash scripts/test-observability.sh` untuk menguji scrape seluruh service/replica, query dashboard, metrik P2/P5, trace Client API–Auth–Aggregator, dan trace polling–outbox–Kafka–kedua consumer, termasuk Sensor Pantai. Test memakai project/volume terpisah dan membersihkannya setelah selesai; ringkasan hasil disimpan di `test-results/observability/summary.json`.

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

Respons Client API mempertahankan `meta.sources` dan flag `meta.partial` tanpa nama storage atau cursor internal. Pesan error 5xx dibuat generik; detail aslinya hanya dicatat di log bersama correlation ID.

Client API membatasi request hazard aktif per instance, dengan kapasitas cadangan khusus role `lapangan`. Role `public` dan `internal` berbagi kapasitas lainnya. Ketika batas tercapai, request ditolak sebelum menghubungi Aggregator dengan `503` dan `Retry-After`; health check tetap dapat diakses. Root `.env.example` menyediakan `BNPB_CLIENT_API_ADMISSION_MAX_CONCURRENT_REQUESTS`, `BNPB_CLIENT_API_ADMISSION_RESERVED_LAPANGAN_REQUESTS`, dan `BNPB_CLIENT_API_ADMISSION_RETRY_AFTER_SECONDS`. Nilai awal 100/20/1 perlu dituning melalui load test, bukan hasil pengukuran kapasitas produksi.

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

2. Record PVMBG sebelum dan sesudah adanya `confidence_level`, berdampingan dalam satu collection:
   ```bash
   docker compose exec canonical-store mongosh --quiet --eval '
     const store = db.getSiblingDB(process.env.CANONICAL_STORE_DB_NAME);
     store.auth(process.env.CANONICAL_STORE_DB_USER, process.env.CANONICAL_STORE_DB_PASSWORD);
     printjson(store.hazard_events.find({source: "PVMBG"}, {_id: 0, sourceRefId: 1, attributes: 1}).sort({ingestedAt: -1}).limit(6).toArray());
   '
   ```
   Hasil yang diharapkan: dokumen dengan dan tanpa `confidence_level` berada dalam collection yang sama, tanpa migrasi skema.\
   Catatan: Jalankan segera setelah mengubah skema agar dokumen tanpa `confidence_level` masih terlihat dalam enam hasil terbaru.

3. Hanya Aggregator yang dikonfigurasi untuk dapat mengakses Canonical Store:
   ```bash
   for s in bnpb-aggregator bnpb-client-api bnpb-auth dashboard-consumer notification-consumer bmkg pvmbg; do
     echo "$s -> $(docker compose exec -T "$s" printenv DATABASE_URL | grep -o '@[^/]*' || echo 'no DATABASE_URL')"
   done
   ```
   Hasil yang diharapkan: hanya `bnpb-aggregator -> @canonical-store:27017`; Client API tidak memiliki database, dan setiap service lainnya mengarah ke store miliknya sendiri.

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

## M2 P3 — Schema evolution, DLQ, dan laporan lapangan

Kebijakan perubahan skema PVMBG dideklarasikan di [SCHEMA_POLICY](docs/SCHEMA_POLICY.md); keputusan di [DECISIONS](docs/orang-c/DECISIONS.md) (D-34 s.d. D-41) dan bukti di [EVIDENCE](docs/orang-c/EVIDENCE.md).

- Mock PVMBG: `POST /admin/schema-version {"mode":"v1|v2_confidence|rename_field|type_change|missing_required"}` (body M1 `{"version":1|2}` tetap berlaku) dan `POST /admin/malformed {"kind":"truncated|deep_nesting|invalid_utf8|oversized","count":1}`.
- Aggregator: mapping PVMBG dibaca dari direktori `BNPB_AGGREGATOR_PVMBG_MAPPING_DIR` (default `services/bnpb-aggregator/config/pvmbg-mapping`, di-mount read-only) dan dimuat ulang saat hash isinya berubah; status per replica di `GET /internal/pvmbg/mapping`. Pesan terparkir diproses ulang lewat `POST /internal-ops/dlq/replay` di Client API (role `internal`).
- Laporan lapangan: `POST /field-reports` di Client API (role `lapangan`/`internal`) membalas `202` setelah Kafka (topic `field-reports`) meng-ack; `field-report-processor` menyimpannya lewat Aggregator. Status: `GET /field-reports/{id}`.

```bash
bash scripts/dlq/p3-malformed-window-test.sh          # P3 #3 + D-34, PASS/FAIL
bash scripts/dlq/p3-schema-demo.sh [--no-pause]       # demo P3 #1-#5 → test-results/p3-schema/<waktu>/
bash scripts/field-reports/p3-field-report-proof.sh   # bukti P3 #6 → test-results/p3-field-report/<waktu>/
```
Ketiga skrip memakai project Compose terisolasi dan `.env.example`, sehingga stack utama dan `.env` tidak disentuh. Pengguna demo dibuat oleh `scripts/seed-users.sh` (password `password`).

## Daftar Variabel Konfigurasi

Berikut adalah daftar variabel konfigurasi yang digunakan pada file `.env`. Nilai default untuk setiap variabel dapat dilihat pada `.env.example`.

```env
# Canonical Store (MongoDB)
CANONICAL_STORE_ROOT_USER=
CANONICAL_STORE_ROOT_PASSWORD=
CANONICAL_STORE_CLUSTER_KEY=
CANONICAL_STORE_DB_USER=
CANONICAL_STORE_DB_PASSWORD=
CANONICAL_STORE_DB_NAME=
CANONICAL_STORE_TRANSACTION_LIFETIME_SECONDS=

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
BNPB_AGGREGATOR_AUDIT_TOKEN=
BNPB_AGGREGATOR_STORAGE_READ_TIMEOUT_MS=
BNPB_AGGREGATOR_MONGO_NODE_MAP=
BNPB_AGGREGATOR_BACKGROUND_LEASE_MS=
BNPB_AGGREGATOR_BACKGROUND_LEASE_RENEW_MS=
BNPB_AGGREGATOR_LEASE_OPERATION_TIMEOUT_MS=
BNPB_AGGREGATOR_KAFKA_TRANSACTIONAL_ID=
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
BNPB_AGGREGATOR_DLQ_REPLAY_MAX=
BNPB_AGGREGATOR_PVMBG_BODY_FAILURE_HOLD_POLLS=
BNPB_AGGREGATOR_PVMBG_MAPPING_DIR=
BNPB_AGGREGATOR_PVMBG_MAPPING_PATH=
BNPB_AGGREGATOR_PVMBG_MAPPING_POLL_MS=

# Field reports (Client API → Kafka)
FIELD_REPORT_TOPIC=
BNPB_CLIENT_API_KAFKA_BROKERS=
BNPB_CLIENT_API_KAFKA_CLIENT_ID=
BNPB_CLIENT_API_FIELD_REPORT_PUBLISH_TIMEOUT_MS=
BNPB_CLIENT_API_FIELD_REPORT_MAX_BODY_BYTES=
BNPB_CLIENT_API_FIELD_REPORT_RETRY_AFTER_SECONDS=

# Field Report Processor
FIELD_REPORT_PROCESSOR_HOST_PORT=
FIELD_REPORT_PROCESSOR_NODE_ENV=
FIELD_REPORT_PROCESSOR_KAFKA_BROKERS=
FIELD_REPORT_PROCESSOR_KAFKA_CLIENT_ID=
FIELD_REPORT_PROCESSOR_KAFKA_GROUP_ID=
FIELD_REPORT_PROCESSOR_LAG_POLL_INTERVAL_MS=
FIELD_REPORT_PROCESSOR_GATEWAY_TIMEOUT_MS=
FIELD_REPORT_PROCESSOR_MAX_MESSAGE_BYTES=
FIELD_REPORT_PROCESSOR_MAX_PERMANENT_ATTEMPTS=
FIELD_REPORT_PROCESSOR_BACKOFF_BASE_MS=
FIELD_REPORT_PROCESSOR_BACKOFF_CAP_MS=

# Fire Processor
FIRE_PROCESSOR_HOST_PORT=
FIRE_PROCESSOR_NODE_ENV=

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
