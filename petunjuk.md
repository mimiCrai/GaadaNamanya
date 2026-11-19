# Petunjuk deployment dan pengujian BNPB

Panduan ini dijalankan dari root repositori dengan Bash (Linux/WSL), dan mengacu pada `instructions.md` yang tersedia di repo. Nama `instruction.md` tunggal tidak ditemukan. PDF M2, katalog referensi dan token asisten belum tersedia saat audit. Hasil aktual dan bagian yang belum memenuhi instruksi dicatat di [docs/audit-instructions.md](docs/audit-instructions.md).

Jalankan tahap 1–5 untuk verifikasi lokal. Tahap 6–15 memerlukan cluster demo yang disediakan terpisah. Tahap 16 mencakup regresi fitur M1/P3/P4. Lulus tes Compose bukan bukti kernel terpisah, NetworkPolicy atau local PV Kubernetes.

## 1. Siapkan workstation dan folder bukti

Prasyarat: Git, Bash, Python 3, OpenSSL, Node.js **22 atau lebih baru**, npm, Docker Engine/Desktop dan Compose v2 yang mendukung `!reset`. Untuk Kubernetes diperlukan `kubectl` serta kubeconfig; untuk beban diperlukan k6 pada mesin penguji di luar Pod aplikasi. Tes renderer Python memerlukan PyYAML (`python3 -m pip install PyYAML` dalam virtual environment bila belum terpasang).

```bash
cd /path/to/GaadaNamanya
node --version
npm --version
python3 --version
openssl version
docker version
docker compose version
kubectl version --client
# k6 version diperlukan saat menjalankan tahap load test.
mkdir -p test-results/manual
export EVIDENCE="$(pwd)/test-results/manual/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE"
git rev-parse HEAD > "$EVIDENCE/commit.txt"
git status --short > "$EVIDENCE/worktree.txt"
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/started-at.txt"
set -o pipefail
```

`pipefail` memastikan kegagalan test tetap menghasilkan exit nonzero saat output disalurkan ke `tee`. Catat RAM/CPU/disk host penguji, versi OS/kernel dan versi tool. Berkas bukti di `test-results/` diabaikan Git. Jangan simpan Secret, kubeconfig mentah atau token pada bukti yang dibagikan.

## 2. Pemeriksaan statis dan manifest tanpa deploy

```bash
python3 -m py_compile scripts/kubernetes/*.py
for file in scripts/kubernetes/*.sh scripts/run-aggregator-load-test.sh; do
  bash -n "$file" || exit 1
done
python3 scripts/kubernetes/test-manifests.py 2>&1 | tee "$EVIDENCE/manifests.log"
node --check scripts/kubernetes/verify-audit.mjs
```

Expected: Python/Bash/JavaScript dapat diparse; sembilan tes manifest lulus. Suite menguji namespace/context wajib, overlap kelompok shard, memory Lampiran B, node cordoned, kernel bersama, storage nonlokal, render seluruh stack, Secret, imagePullSecrets dan determinisme versi Job. Tes ini tidak membuat resource cluster atau membuka Docker daemon; ia memakai `docker compose config`, OpenSSL dan PyYAML.

Untuk pemeriksaan schema Kubernetes, render ke direktori privat dengan input deployment yang valid, lalu jalankan dry-run pada context development yang sudah tersedia:

```bash
umask 077
export RENDER_DIR="$(mktemp -d)"
python3 scripts/kubernetes/render-full-stack.py k8s/full-stack.json .env.k8s "$RENDER_DIR"
for manifest in "$RENDER_DIR"/*.json; do
  kubectl --context "$KUBE_CONTEXT" -n default create --dry-run=client --validate=true -f "$manifest" -o name || break
done
```

Direktori render mengandung Secret; jangan commit atau unggah isinya. Hapus direktori sementara milik proses ini setelah selesai. Dry-run memvalidasi schema, belum membuktikan scheduler, CNI, image pull, readiness atau replikasi.

## 3. Build dan unit test seluruh service

```bash
(
  set -euo pipefail
  for service in bmkg pvmbg bnpb-auth bnpb-client-api bnpb-aggregator dashboard-consumer notification-consumer; do
    npm --prefix "services/$service" ci --no-audit --no-fund
    npm --prefix "services/$service" run build 2>&1 | tee "$EVIDENCE/$service-build.log"
    npm --prefix "services/$service" test -- --watch=false 2>&1 | tee "$EVIDENCE/$service-unit.log"
  done
)
```

Expected: ketujuh build berhasil; audit saat ini memperoleh 501 test lulus. Jika memakai sandbox yang melarang `listen`, jalankan test HTTP pada host dengan izin membuka port lokal.

Cakupan termasuk canonicalization, validation, API/auth, fencing lease, cursor, checksum, partial result, outbox, DLQ, sensor, Kafka consumers dan analitik. Unit test tidak membuktikan failover atau throughput cluster.

## 4. Jalankan stack lokal dan smoke test manual

Buat `.env` jika belum ada; jangan menimpa credential deployment yang sudah dipakai.

```bash
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
# Sesuaikan credential/token pada .env, termasuk private key RSA Auth.
docker compose config --quiet
docker compose up -d --build
docker compose ps | tee "$EVIDENCE/compose-ps.txt"
curl --fail --max-time 10 http://localhost:3001/health/ready
curl --fail --max-time 10 http://localhost:3000/health/ready
curl --fail --max-time 10 http://localhost:3003/health/ready
curl --fail --max-time 10 http://localhost:8081/health
curl --fail --max-time 10 http://localhost:8082/health
curl --fail --max-time 10 http://localhost:8083/healthz
curl --fail --max-time 10 http://localhost:3004/api/hazards/analytics
```

Gunakan port `.env` bila berbeda. Buka `http://localhost:3004/dashboard` dan `http://localhost:3005/notifications`. Dashboard berisi line chart jumlah harian UTC per hazard type, pemilih rentang waktu, tabel severity/area serta status canonical. Daftar event pada tabel merupakan projection Kafka sehingga dapat tertinggal dari angka canonical.

Pada local default, Sensor Pantai memakai image resmi; feed satelit memerlukan token asisten bila diaktifkan. Enum hazard aktual proyek adalah `SEISMIC`, `VOLCANIC`, `WILDFIRE`, `COASTAL`; informasi tsunami saat ini terintegrasi pada kejadian seismic/atribut peringatan, bukan enum `TSUNAMI` terpisah.

Smoke Auth dan Client API:

```bash
curl --fail http://localhost:3001/public-key
curl -sS -o /tmp/bnpb-unauthorized.json -w '%{http_code}\n' http://localhost:3000/hazards
curl --fail -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"tester@example.test","password":"TestPassword123!"}'
```

Expected: public key tersedia; akses tanpa JWT `401`; register mengembalikan access/refresh token. Simpan token secara privat, lalu uji:

```bash
read -r -s -p 'Access token: ' ACCESS_TOKEN; echo
curl --fail http://localhost:3000/hazards -H "Authorization: Bearer $ACCESS_TOKEN"
unset ACCESS_TOKEN
```

Refresh, logout, pembatasan peran, projection dan notifikasi juga diuji otomatis di tahap 5. Jangan menyalin respons register berisi token ke bukti publik.

## 5. End-to-end, integrasi, shard outage dan recovery lokal

```bash
bash scripts/test-e2e.sh 2>&1 | tee "$EVIDENCE/e2e.log"
```

Untuk mengulang hanya smoke alur aplikasi serta audit/analitik storage, gunakan `bash scripts/test-audit-storage.sh`; project-nya `bnpb-storage-e2e` dan juga dibersihkan setelah selesai.

Script penuh membuat project **`bnpb-e2e`** terpisah, build image, menjalankan stack, integrasi MongoDB/Kafka, E2E aplikasi, audit/analitik normal, mematikan **semua anggota shard B**, memeriksa hasil parsial, menghidupkannya kembali, dan menguji recovery. Trap membersihkan container/network/volume **project uji itu** setelah selesai. Volume stack lokal biasa tidak dipakai. Jangan memakai nama project tersebut untuk data yang ingin dipertahankan.

Expected:

- 58 test integrasi MongoDB/Kafka (lease/fencing, outbox, DLQ, urutan PVMBG, satellite log/Kafka) lulus.
- 12 test alur aplikasi lulus: sumber → canonical store → outbox → Kafka → consumer, Auth dan Client API.
- Audit normal: auth/validasi, pagination, checksum, tiga lokasi termasuk primary, missing event `404`.
- Outage seluruh shard B: request tetap selesai, `partial:true`, `unavailable_units` memuat `canonical-shard-b`, dan event shard sehat tetap dikembalikan. Analitik juga bertanda partial/degraded.
- Recovery: `partial:false`, unit unavailable kosong, data kembali terbaca.
- Proxy dashboard menerima query rentang `from` dan meneruskan status coverage dari Aggregator.

Test berhenti bila satu tahap gagal. Simpan log sebelum mengulang. Ini menguji kegagalan satu shard, bukan menghapus disk node Kubernetes.

## 6. Sediakan cluster demo dan catat topologi fisik

Entry point full-stack memakai **enam node schedulable** agar dua shard × tiga salinan data tidak membuat satu node menyimpan semua data. Gunakan VM Linux atau mesin native dengan kernel terpisah. Docker Desktop/kind/k3d hanya development; enam container node tetap tidak menjadi enam kernel.

Contoh perencanaan berikut **bukan inventaris hardware aktual**. Isi host fisik, alokasi dan IP sebenarnya pada bukti:

| Node/VM | Peran | IP contoh | Alokasi VM awal | Host fisik dan spesifikasi aktual |
| --- | --- | --- | --- | --- |
| bnpb-a | server K3s + worker; shard A/config; singleton dependency | 192.168.56.11 | 4 vCPU, 12 GiB RAM, 100 GiB disk | isi nama host, CPU, RAM, disk |
| bnpb-b | worker; shard A/config | 192.168.56.12 | 2 vCPU, 4 GiB RAM, 50 GiB disk | isi |
| bnpb-c | worker; shard A/config | 192.168.56.13 | 2 vCPU, 4 GiB RAM, 50 GiB disk | isi |
| bnpb-d | worker; shard B | 192.168.56.14 | 2 vCPU, 4 GiB RAM, 50 GiB disk | isi |
| bnpb-e | worker; shard B | 192.168.56.15 | 2 vCPU, 4 GiB RAM, 50 GiB disk | isi |
| bnpb-f | worker; shard B | 192.168.56.16 | 2 vCPU, 4 GiB RAM, 50 GiB disk | isi |
| load generator | di luar Pod aplikasi | jaringan routable | ukur kapasitas untuk 10.000 VU | isi |

Jika beberapa VM memakai satu host fisik, hitung total alokasi terhadap kapasitas host; catat failure domain fisik yang sama. Enam VM di satu host mempunyai enam kernel, tetapi kegagalan host tersebut tetap mematikan semuanya. Siapkan jaringan privat antarnode dan rute dari workstation. Untuk default K3s, izinkan TCP 6443 ke server dan UDP 8472 antar-VM; sesuaikan firewall dengan CNI yang dipilih. Jangan menonaktifkan NetworkPolicy controller.

Di tiap VM, salin contoh `k8s/k3s/server-a.yaml.example` atau `worker-<huruf>.yaml.example`, isi IP dan interface jaringan, lalu pasang sebagai `/etc/rancher/k3s/config.yaml`. A:

```bash
sudo install -D -m 600 server-a.yaml /etc/rancher/k3s/config.yaml
curl -sfL https://get.k3s.io | sh -
sudo cat /var/lib/rancher/k3s/server/node-token
```

Catat token secara privat. B–F, dengan file config masing-masing:

```bash
sudo install -D -m 600 worker-b.yaml /etc/rancher/k3s/config.yaml
read -r -s -p 'K3s join token: ' K3S_TOKEN; echo
export K3S_TOKEN
export K3S_URL=https://192.168.56.11:6443
curl -sfL https://get.k3s.io | sh -
unset K3S_TOKEN
cat /proc/sys/kernel/random/boot_id
```

Ganti file worker-b pada tiap VM sesuai hurufnya. Catat boot ID keenam VM, IP, disk dan host fisik. Pemasangan K3s memerlukan akses Internet dan sudo pada VM; dilakukan terpisah dari deploy aplikasi. Pilih versi K3s yang sama pada semua node dan catat versi yang digunakan.

Salin kubeconfig server melalui saluran privat ke workstation; ubah alamat API dari localhost ke IP server serta beri nama context `bnpb-demo`. Kubeconfig mengandung credential cluster, jangan commit. Selanjutnya:

```bash
export KUBE_CONTEXT=bnpb-demo
export NS=sistem-informasi-kebencanaan-bnpb
kubectl --context "$KUBE_CONTEXT" get nodes -o wide | tee "$EVIDENCE/nodes.txt"
kubectl --context "$KUBE_CONTEXT" get nodes -o json > "$EVIDENCE/nodes.json"
kubectl --context "$KUBE_CONTEXT" get storageclass -o yaml > "$EVIDENCE/storageclass.yaml"
```

Expected: enam node Ready, tidak cordoned/tainted yang melarang workload, label hostname sesuai nama konfigurasi, boot ID semuanya berbeda, dan `local-path` memakai provisioner `rancher.io/local-path` serta `WaitForFirstConsumer`. Preflight memeriksa alokasi memori minimum; tetap periksa beban Pod lain dan kapasitas disk backing storage secara langsung pada VM.

## 7. Konfigurasi, credential, registry dan deploy satu perintah

```bash
cp k8s/full-stack.json.example k8s/full-stack.json
python3 scripts/kubernetes/init-secrets.py
```

Generator menolak menimpa `.env.k8s` yang sudah ada. Isi konfigurasi JSON:

| Input | Nilai/fungsi |
| --- | --- |
| namespace | wajib `sistem-informasi-kebencanaan-bnpb` |
| context | nama context eksplisit, contoh `bnpb-demo` |
| imageRepository | repository yang dapat ditarik semua node, contoh `docker.io/AKUN/bnpb` |
| imageTag | versi unik; tag image menjadi `<service>-<versi>` |
| stableNodeName | `bnpb-a`, node singleton dependency |
| storageNodes.a | A/B/C, masing-masing berbeda |
| storageNodes.b | D/E/F, tidak beririsan kelompok A |
| storageClassName | `local-path` dengan disk lokal dan binding menunggu konsumen |
| imagePullSecret | kosong untuk image publik, atau nama Secret registry privat |
| resources | memory Lampiran B yang sudah diisi; CPU opsional |

Review `.env.k8s` secara privat. URI database harus memakai credential store pemiliknya. Token BMKG/PVMBG/Sensor harus sama pada sumber dan Aggregator. Token feed asli diisi dari asisten jika feed diaktifkan; generator mengosongkan token contoh. Jangan membuat token acak pengganti token feed resmi. Backup `.env.k8s` sebelum deploy; deploy ulang memverifikasi credential lama.

```bash
docker login
# Hanya bila registry privat, siapkan namespace dan imagePullSecret sebelum deploy:
# kubectl --context "$KUBE_CONTEXT" create namespace "$NS"
# kubectl --context "$KUBE_CONTEXT" -n "$NS" create secret generic registry-access \
#   --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson=/path/to/private-docker-config.json
KUBE_CONTEXT=bnpb-demo bash scripts/kubernetes/deploy-all.sh 2>&1 | tee "$EVIDENCE/deploy.log"
```

Expected: preflight → render → build/push tujuh image → namespace/config/policy → MongoDB bootstrap/migration → infra → topic Job → aplikasi → verify dan smoke, exit 0. Tidak perlu edit YAML di tengah deploy. Gunakan `SKIP_IMAGE_BUILD=1` hanya jika semua image versi tersebut sudah dipublikasikan.

Uji idempotensi dengan command sama. Count/checksum dataset beku serta credential harus tetap sama, PVC tetap terikat, replica set tidak diinisialisasi ulang. Untuk perubahan aplikasi/migration gunakan `imageTag` baru. Job diberi hash spesifikasi; bila Job dengan hash sama pernah gagal, periksa log dan hapus **Job gagal tersebut saja** sebelum mencoba kembali, bukan PVC atau replica set.

## 8. Inventaris komponen, role, resource dan ownership

Seluruh aplikasi berada dalam namespace `$NS`; Tester Agent berada pada namespace terpisah. Detail partisi/replikasi dan diagram ada di [deployment guide](docs/kubernetes-deployment.md).

| Komponen | Image/port di cluster | Dependency, config/credential dan volume | Health | role; memory request/limit |
| --- | --- | --- | --- | --- |
| Aggregator ×3 | image repo; 3000 | MongoDB, Kafka, mock/sensor/feed; Secret internal/audit/token/URI; ConfigMap polling | /health/live, /health/ready | aggregator; 256Mi/512Mi |
| shard A/B, 3 anggota tiap shard | mongo:7.0.32; 27017 | cluster key/root Secret, local PVC 10Gi per anggota | Mongo ping, replSetGetStatus | store; 512Mi/1Gi |
| config RS ×3 | mongo:7.0.32; 27017 | cluster key/root Secret; local PVC 10Gi | Mongo ping, replSetGetStatus | store; 512Mi/1Gi |
| mongos ×2 | mongo:7.0.32; 27017 | config RS, Mongo Secret/scripts; tanpa disk data | Mongo ping | other; 128Mi/256Mi |
| 5 PostgreSQL | postgres:16-alpine; 5432 | Secret POSTGRES_USER/PASSWORD/DB; local PVC 5Gi masing-masing | pg_isready | store; 512Mi/1Gi |
| Kafka ×1 | confluentinc/cp-kafka:7.7.1; 29092 | ConfigMap KRaft; PVC 10Gi pada A | kafka-topics --list | broker; 512Mi/1Gi |
| Auth | image repo; 3000 | auth-store, Secret RSA/URI; ConfigMap JWT TTL | /health/live, /health/ready | api; 128Mi/256Mi |
| Client API | image repo; 3000 | Auth/public key, Aggregator/internal key, ConfigMap admission | /health/live, /health/ready | api; 128Mi/256Mi |
| dashboard/notification consumer | image repo; 3000 | Kafka, store masing-masing; dashboard → Aggregator analitik | /health/live, /health/ready | consumer; 128Mi/256Mi |
| BMKG/PVMBG | image repo; 8081/8082 | store masing-masing, Secret token, ConfigMap generator/delay | /health | mock; 64Mi/128Mi |
| Sensor Pantai | digest resmi di Compose; 8080 | Secret PANTAI_AUTH_TOKEN, PVC 2Gi pada A | /healthz | sensor; 128Mi/256Mi (kelas other sementara) |
| bootstrap/migration/topic Jobs | Mongo/Aggregator/Kafka image | Secret dan ConfigMap sesuai pemilik; tanpa persistent data sendiri | Job Complete | other; 128Mi/256Mi |
| observabilitas lengkap | belum tersedia | lihat gap audit | belum tersedia | belum memenuhi instruksi |

Mongos bukan salinan data dan tidak dihitung sebagai store fisik. Tidak ada sidecar aplikasi pada renderer. Semua konfigurasi nonrahasia masuk ConfigMap, password/key/token/URI masuk Secret. Private registry credential dikelola lewat imagePullSecret. CPU opsional; jika menambah sidecar, hitung ulang anggaran **seluruh Pod**.

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods,sts,deploy,jobs,pvc,networkpolicy -o wide > "$EVIDENCE/resources.txt"
python3 scripts/kubernetes/verify-platform.py "$NS" | tee "$EVIDENCE/platform.json"
bash scripts/kubernetes/verify-mongo.sh "$NS" | tee "$EVIDENCE/mongo.txt"
bash scripts/kubernetes/verify-isolation.sh "$NS" | tee "$EVIDENCE/isolation.txt"
```

Expected: label/memory benar; baseline Aggregator pada ≥3 node berbeda; kelompok data shard berbeda; PV store bersifat local/hostPath dan affinity sesuai node Pod; replica set sehat; chunk berada di dua shard. Isolation menguji pemilik **allow** dan service lain **deny** ke Service **serta IP Pod**, termasuk direct member MongoDB. DNS gagal bukan bukti policy menolak. Verifikasi ini memerlukan CNI yang benar-benar menegakkan NetworkPolicy.

## 9. Endpoint dan token pengujian Kubernetes

```bash
export AGGREGATOR_URL=http://192.168.56.11:30003
export CLIENT_API_BASE_URL=http://192.168.56.11:30000
export AUTH_BASE_URL=http://192.168.56.11:30001
export DASHBOARD_URL=http://192.168.56.11:30004
read -r -s -p 'Audit token dari .env.k8s: ' BNPB_AUDIT_TOKEN; echo
export BNPB_AUDIT_TOKEN
read -r -s -p 'Internal API key dari .env.k8s: ' BNPB_INTERNAL_API_KEY; echo
export BNPB_INTERNAL_API_KEY
curl --fail --max-time 10 "$AGGREGATOR_URL/health/ready"
curl --fail --max-time 10 "$AGGREGATOR_URL/internal/audit/events?limit=2" -H "Authorization: Bearer $BNPB_AUDIT_TOKEN"
curl --fail --max-time 10 "$AGGREGATOR_URL/internal/hazards?limit=50" -H "X-BNPB-Internal-Key: $BNPB_INTERNAL_API_KEY"
```

Buka `$DASHBOARD_URL/dashboard`. `GET /internal/audit/unprocessed` tetap tersedia dengan audit token. Audit token berbeda dari internal key dan JWT pengguna. Jangan mencetak atau memasukkan Secret ke rekaman layar.

## 10. Import katalog, deduplikasi, distribusi dan skew

Gunakan katalog asisten bila tersedia; fixture berikut hanya verifikasi awal. Format importer: UTF-8 NDJSON dengan field canonical camelCase; bukan CSV atau JSON array mentah. `source` BMKG/PVMBG, `hazardType` SEISMIC/VOLCANIC. Jika format asisten berbeda, buat konverter dan validasi jumlah serta `sourceRefId` tanpa mengubah identitas. Simpan checksum file input.

```bash
python3 - <<'PY'
import json
from pathlib import Path
out=Path('test-results/history.ndjson');out.parent.mkdir(exist_ok=True)
with out.open('w') as f:
    for i in range(1000):
        f.write(json.dumps({'source':'BMKG','sourceRefId':f'history-{i:06d}',
            'hazardType':'SEISMIC','severity':'SIAGA','areaName':['Aceh','Jawa','Maluku'][i%3],
            'latitude':5.55,'longitude':95.32,'occurredAt':'2020-01-01T00:00:00.000Z',
            'attributes':{'magnitude':6.1}})+'\n')
PY
sha256sum test-results/history.ndjson > "$EVIDENCE/catalog-file.sha256"
bash scripts/kubernetes/import-history.sh test-results/history.ndjson | tee "$EVIDENCE/import.log"
bash scripts/kubernetes/import-history.sh test-results/history.ndjson | tee "$EVIDENCE/import-repeat.log"
python3 scripts/kubernetes/verify-distribution.py | tee "$EVIDENCE/distribution.json"
```

Importer mengambil lease milik Aggregator dan memakai transaksi/outbox yang sama. Helper menghentikan Aggregator sementara, membuat Pod importer yang tidak masuk endpoint ready Service, lalu mengembalikan replica count awal melalui trap. REST Aggregator tidak tersedia selama import helper ini; jangan memakainya sebagai bukti import tanpa downtime. Setelah berhasil, jalankan ulang input yang sama: `created=0`, `updated=0`, `unchanged=1000`. Record baru masuk consumer setelah relay kembali berjalan.

`verify-distribution.py` membaca ID fisik dari **semua enam anggota data**, menggabungkannya per node, dan memeriksa setiap node menyimpan subset serta setiap event mempunyai tiga salinan pada node berbeda. Jalankan setelah sinkronisasi/balancer selesai, pada dataset beku; orphan hasil migration chunk yang belum dibersihkan dapat membuat pemeriksaan fisik gagal dan perlu diinvestigasi.

Untuk lonjakan satu wilayah, buat fixture kedua dengan 1000 `sourceRefId` baru dan `areaName` seluruhnya `Aceh`, import, lalu bandingkan distribusi sebelum/sesudah. Ukur CPU/memory `kubectl top nodes` dan `kubectl top pods -n "$NS"` (memerlukan metrics-server), ukuran data/`dbStats`, `serverStatus().opcounters`, replication lag dan waktu import pada interval sebelum/selama/sesudah. Hash seharusnya membagi write walau area sama; **jumlah chunk saja tidak membuktikan sebaran record atau write**. Exporter/dashboard metrik menyeluruh belum tersedia, sehingga S02 belum dapat dinyatakan lulus hanya dari script count.

## 11. Audit pagination, checksum dan angka dashboard

Bekukan perubahan input pada dataset pembuktian: hentikan generator/publisher sumber atau gunakan konfigurasi fixture statis, tunggu polling/outbox selesai. Biarkan Aggregator melayani baca. Cursor merupakan keyset, bukan snapshot; penambahan/update record di tengah uji dapat mengubah hasil.

```bash
# Opsional: AUDIT_SOURCE=BMKG untuk katalog satu sumber.
PAGE_SIZE=50 node scripts/kubernetes/verify-audit.mjs | tee "$EVIDENCE/audit-verification.json"
```

Expected: seluruh halaman terurut `ingested_at` lalu `hazard_id`, tanpa ID ganda, cursor berakhir null, `since` inklusif, auth/limit invalid ditolak, checksum SHA-256 cocok dengan `source_ref_id` byte ascending yang dipisahkan newline tanpa newline akhir. Semua event logis dihitung sekali; location memakai nama node aktual dari `kubectl get nodes` dan satu primary/dua replica. Uji ini memerlukan nonempty data, seluruh shard sehat dan token valid.

```bash
curl --fail --max-time 10 "$AGGREGATOR_URL/internal/audit/checksum?source=BMKG" -H "Authorization: Bearer $BNPB_AUDIT_TOKEN" > "$EVIDENCE/checksum-bmkg.json"
curl --fail --max-time 10 --get "$DASHBOARD_URL/api/hazards/analytics" --data-urlencode from=2020-01-01T00:00:00Z --data-urlencode to=2021-01-01T00:00:00Z > "$EVIDENCE/analytics.json"
```

Untuk membandingkan dengan analitik, kumpulkan semua halaman Audit API, lalu filter sendiri `occurred_at >= from && occurred_at < to`; parameter audit `since` memfilter **ingested_at**, jadi bukan pengganti filter waktu kejadian. Hitung total, severity, area, serta bucket harian UTC/tipe dan cocokkan dengan JSON dashboard. Untuk checksum asisten, pastikan sumber dan seluruh cakupan dataset sama; record mock tambahan dapat mengubah hash. Gunakan lingkungan fixture bersih dengan generator dinonaktifkan untuk uji referensi penuh.

## 12. Node/shard outage, kehilangan disk, node baru dan recovery

Lakukan pada cluster uji setelah mencatat target dan baseline. Gangguan worker yang hanya menghilangkan satu anggota RS berbeda dengan mematikan seluruh shard: yang pertama masih dapat memberi hasil lengkap, yang kedua harus memberi partial. Jangan menganggap `partial=false` pada satu worker mati sebagai kegagalan jika replica sehat menyediakan seluruh data; dashboard tetap harus menandai degradasi.

1. Jalankan `verify-mongo.sh`, `verify-platform.py`, `verify-distribution.py` dan simpan checksum dataset beku.
2. Mulai request baca berulang dengan deadline, tulis lewat ingestion normal, dan rekam write yang sudah diakui serta waktu respons.
3. Jalankan skenario Tester Agent yang relevan (tahap 13), atau matikan **worker non-control-plane** melalui hypervisor. Catat node dan boot ID. Untuk bukti disk-loss, disk backing lokal target harus benar-benar hilang/kosong; restart Pod saja tidak cukup.
4. Selama gangguan, pantau `/internal/audit/events`, `/internal/audit/checksum`, daftar terbaru dan dashboard. Catat HTTP status, durasi, `partial`, `unavailable_units`, serta `degraded`/`degraded_units` analitik.
5. Join node pengganti dengan disk kosong dan kernel terpisah. Perbarui kelompok penempatan yang sama. Buktikan initial sync, node baru menanggung data **dan write baru** saat baca/tulis berlangsung.
6. Setelah seluruh replika sehat, bandingkan checksum terhadap write yang diakui/dataset beku dan jalankan ulang distribusi fisik. Kemudian ulangi kehilangan **worker lain** untuk membuktikan ketahanan kembali.

Implementasi saat ini **belum mengotomatisasi** penggantian node/PVC untuk kehilangan disk permanen. Jangan mengubah langkah repair manual menjadi klaim S04–S06 lulus game day. Prosedur manual ordinal 2 dan batas `replace-node.sh` ada di [recovery guide](docs/kubernetes-recovery.md).

Untuk drill satu volume ordinal 2 pada node yang masih dapat dijadwalkan:

```bash
export BNPB_AGGREGATOR_AUDIT_TOKEN="$BNPB_AUDIT_TOKEN"
bash scripts/kubernetes/check-recovery.sh before "$EVIDENCE/baseline.json"
bash scripts/kubernetes/replace-member.sh "$NS" canonical-shard-b --lost-volume
bash scripts/kubernetes/verify-mongo.sh "$NS"
bash scripts/kubernetes/check-recovery.sh after "$EVIDENCE/baseline.json"
```

Script menghapus PVC target setelah memeriksa dua anggota sehat. Pastikan data baseline tidak berubah saat membandingkan hash. Local PV tidak otomatis berpindah lewat `drain`; PVC node hilang dapat tetap Pending/terikat. Jangan menghapus data dua survivor atau memaksa reinitialize RS. A menampung satu control plane dan singleton dependency; kehilangan A belum didukung sebagai failover seluruh sistem.

## 13. Tester Agent resmi

Pasang hanya pada cluster demo yang diperuntukkan pengujian. Manifest dan digest berikut berasal dari `instructions.md`:

```bash
kubectl --context "$KUBE_CONTEXT" apply -f https://raw.githubusercontent.com/susTuna/if4031-tester-agent/ebb55261711123a9a211739ffbf140a275caa6da/manifest.yaml
kubectl --context "$KUBE_CONTEXT" -n tester-agent get daemonset,pods -o wide
kubectl --context "$KUBE_CONTEXT" -n tester-agent get daemonset tester-agent -o jsonpath='{.spec.template.spec.containers[*].image}{"\n"}'
kubectl --context "$KUBE_CONTEXT" exec -n tester-agent daemonset/tester-agent -- /app list
```

Expected image: `sustuna/tester-agent@sha256:b3143da159cf23a8744ede12b847da6208353754234d53a5a7b46d071cf277ec`, satu Pod per node. Pertahankan privilege, RBAC, resource dan kemampuan gangguannya sesuai manifest resmi. Jangan mengubah image atau menerapkan kelas memory aplikasi pada Tester Agent.

```bash
# Ganti NAMA_SKENARIO dengan hasil /app list, jangan menebak namanya.
kubectl --context "$KUBE_CONTEXT" exec -n tester-agent daemonset/tester-agent -- /app run practice NAMA_SKENARIO
kubectl --context "$KUBE_CONTEXT" -n tester-agent logs NAMA_POD_PADA_NODE_TARGET > "$EVIDENCE/tester-agent.log"
```

Biarkan Agent berjalan selama uji; simpan node target, start/end UTC dan hasil tiap skenario. Kunci ujian memerlukan asisten. Sensor Pantai harus memakai `sustuna/sensor-pantai@sha256:51fbd90d3891ad6e9f5768ad330ffb65205644cb29e50da65c7538f2e0b4397d`; pastikan digest Pod aktual, token Secret dan `role=sensor`.

## 14. Readiness, lease takeover, clock skew dan freeze

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods -l app=bnpb-aggregator -o wide
kubectl --context "$KUBE_CONTEXT" -n "$NS" get endpointslice -l kubernetes.io/service-name=bnpb-aggregator -w
```

Baseline: tiga instance pada node berbeda. Startup/liveness memakai `/health/live`; readiness mengecek database. Probe readiness setiap 3 detik, dua kegagalan, timeout 3 detik; ini konfigurasi, bukan hasil pengukuran. Saat instance dihentikan/freeze, rekam saat probe gagal, EndpointSlice menghapus readiness dan request baru berhenti menuju instance tersebut. Liveness tidak menggantungkan kelangsungan proses pada broker/sumber mock.

Verifikasi lokal koordinasi yang sudah tersedia:

```bash
bash scripts/test-aggregator-failover.sh 2>&1 | tee "$EVIDENCE/failover.log"
```

Project `bnpb-failover` terisolasi menguji crash leader, offset jam +45/−30 detik, freeze melewati lease lalu resume dan pencegahan duplicate/commit owner lama. Untuk penerimaan Kubernetes, ulangi dengan mekanisme gangguan Tester Agent/hypervisor dan bukti upstream, epoch lease, count/checksum serta timestamp takeover ≤60 detik. Jangan mengubah jam node database ketika yang diuji skew jam aplikasi. `NODE_OPTIONS` hook jam uji terdapat pada override Compose; jangan dipasang pada produksi tanpa skenario yang jelas.

Polling tetap single-owner walaupun REST di semua replica. Resume instance lama harus gagal commit sampai memperoleh lease baru. Catat query `GET /internal/leadership` dengan internal key, log pemanggil mock dan correlation ID. Tiga Pod saja belum membuktikan fencing.

## 15. Load test, skala 3→5→2 dan rolling versi

Generator beban berjalan pada host penguji di luar Pod aplikasi, dengan resource cukup untuk ≥10.000 VU selama ≥120 detik. Default script 10.000 VU ×150 detik. Dataset harus nonkosong dan lengkap. Catat CPU/RAM/NIC host beban, jaringan, image version, ukuran respons dan seluruh konfigurasi.

```bash
export TARGET=kubernetes
export KUBE_CONTEXT=bnpb-demo
export KUBE_NAMESPACE=sistem-informasi-kebencanaan-bnpb
export AGGREGATOR_URL=http://192.168.56.11:30003
# BNPB_INTERNAL_API_KEY sudah di-export di tahap 9.
bash scripts/run-aggregator-load-test.sh smoke
bash scripts/run-aggregator-load-test.sh sustained
bash scripts/run-aggregator-load-test.sh scaling
bash scripts/run-aggregator-load-test.sh benchmark
export AGGREGATOR_IMAGE=docker.io/AKUN/bnpb:bnpb-aggregator-VERSI_BARU
bash scripts/run-aggregator-load-test.sh rolling
```

Expected: smoke hanya pemeriksaan awal, bukan bukti skala 10.000 VU. Sustained/scaling/benchmark memerlukan unexpected error rate <1%; controlled rejection dicatat terpisah. Scaling mencapai 3→5→2 saat load masih berjalan. Penyebaran memakai `maxSkew=1`, bukan aturan wajib satu Pod per node untuk seluruh replika; enam node juga memberi ruang rollout. Benchmark sukses 3 instance/1 instance ≥2,0×. Rolling menggunakan image berbeda, `maxUnavailable=0`, `maxSurge=1`, drain dan graceful shutdown; mode ini menuntut nol request gagal maupun controlled rejection.

Script menyimpan summary JSON/log/events CSV di `test-results/p2-load/`, serta mengembalikan image/replica awal melalui trap. Periksa timeline agar scale/rollout selesai sebelum load berakhir. Tambah durasi bila perlu; jangan menurunkan VU/durasi lalu menyebut hasilnya memenuhi P2.6. Pengukuran hanya membuktikan kapasitas lingkungan yang direkam.

## 16. Regresi fitur lain dan alat pengujian yang tersedia

Jalankan setelah alur dasar lulus. Skrip Compose khusus membuat project uji sendiri; DLQ demo dan load client bekerja terhadap stack yang sedang dijalankan.

| Uji | Command | Expected/bukti |
| --- | --- | --- |
| Sensor Pantai | `bash scripts/test-sensor-pantai.sh` | COASTAL, token/cursor, breaker/freeze, data invalid, notifikasi; project `bnpb-sensor-e2e` dibersihkan |
| Feed satelit stub | `bash scripts/satellite/p4-reconnect-test.sh --pause` | checkpoint durable, reconnect tanpa gap, deduplikasi; `test-results/p4-reconnect/` |
| Feed resmi | `SATELLITE_TOKEN=... bash scripts/satellite/p4-reconnect-test.sh --real --pause` | token asisten, satu koneksi stream; jangan jalankan bersamaan dengan observer/stack feed lain |
| Load Client API | `bash scripts/run-load-test.sh` | auth/refresh, admission, latency/error; `test-results/k6-client-api-summary.json` |
| Isolasi sumber lambat | `bash scripts/run-source-isolation-test.sh` | PVMBG lambat tidak menghentikan BMKG; `test-results/k6-source-isolation-summary.json` |
| DLQ manual | `PW=... bash scripts/dlq/p3-dlq-demo.sh` | poison mock PVMBG dikarantina; pagination audit/unprocessed; raw SHA-256; role internal-only; butuh akun media/field/ops |
| Memori safe decode | `node scripts/dlq/measure-safe-decode-memory.cjs` | pengukuran parser sesuai argumen tool; baca header script untuk input |

Untuk akun internal/field, gunakan bootstrap admin dan alat `scripts/seed-users.sh` setelah meninjau inputnya. Jangan memakai password contoh pada deployment demo yang dibagikan. P3/P4 di luar kebutuhan integrasi Kubernetes tetap mengikuti spesifikasi fiturnya; tabel ini mencantumkan seluruh entry point pengujian utama, bukan klaim semua skenario sudah dijalankan saat audit ini.

## 17. Observabilitas, bukti dan troubleshooting

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NS" get events --sort-by=.lastTimestamp > "$EVIDENCE/events.txt"
kubectl --context "$KUBE_CONTEXT" -n "$NS" logs -l app=bnpb-aggregator --all-containers --prefix --tail=500 > "$EVIDENCE/aggregator.log"
curl --fail --max-time 10 "$AGGREGATOR_URL/metrics" > "$EVIDENCE/aggregator.prom"
```

Correlation ID berbentuk UUID diteruskan pada jalur Client API → Aggregator/sumber dan dicatat dalam log. Gunakan ID sama untuk menelusuri alur. Metrik Aggregator yang tersedia terutama proses, ingestion satellite/DLQ; dashboard metrik lintas seluruh service, storage write/lag dan trace durasi tiap langkah belum lengkap. Jangan memakai log biasa sebagai bukti bahwa distributed tracing sudah tersedia.

| Gejala | Pemeriksaan/perbaikan |
| --- | --- |
| Node/context tidak ditemukan | cek context eksplisit pada JSON/`KUBE_CONTEXT`, kubeconfig dan rute API; jangan bypass preflight demo dengan flag development |
| Pod Pending | `describe pod`, taint/cordon, request memory, disk dan anti-affinity; kelompok shard harus disjoint dan berisi tiga node siap |
| PVC Pending setelah node hilang | periksa PV node affinity/reclaim dan survivor; local disk tidak pindah melalui drain; ikuti recovery guide |
| ImagePullBackOff | cek tag hasil push, registry DNS/TLS, imagePullSecret pada namespace aplikasi dan image semua arsitektur node |
| Job gagal/timeout | cari nama Job ber-hash dari `get jobs`, `logs job/NAMA`, `describe job`; perbaiki sebab sebelum retry; jangan hapus PVC |
| Credential mismatch | pulihkan `.env.k8s` asli; mengganti Secret tidak mengganti password database pada volume lama |
| Audit normal selalu partial | cek direct shard policy, user monitoring lokal shard, metadata permission, shard election/timeout dan API RBAC |
| Dashboard 400 ketika range dipilih | pastikan image/dashboard OpenAPI terbaru memuat query `from`/`to` |
| Dashboard 503/partial | cek owner API/internal key, NetworkPolicy dashboard→Aggregator dan coverage shard; jangan memakai angka projection sebagai hasil lengkap |
| `verify-audit` hash/count berubah | hentikan mutasi input, tunggu konsistensi replika, restart pagination jika availability berubah, samakan sumber/waktu/dataset |
| Isolation deny juga untuk pemilik | periksa DNS/CNI/port/readiness; deny akibat service mati bukan bukti enforcement |
| k6 kehabisan socket/memori | periksa host generator, limit OS, jaringan dan kapasitas cluster; simpan hasil gagal apa adanya |

Untuk setiap K01–K05, S01–S07, A01–A03, rekam `lulus`, `gagal`, atau `belum diuji`, command, prasyarat, node/kernel, waktu UTC, hasil aktual dan berkas bukti. Jangan mengubah `belum diuji` menjadi lulus hanya karena manifest tersedia. Lihat [matriks audit](docs/audit-instructions.md) sebagai baseline saat ini.
