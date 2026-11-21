# Deployment Kubernetes BNPB M2

Panduan lengkap beserta perintah uji dan kriteria penerimaan ada di [petunjuk.md](../petunjuk.md). Status hasil audit dan batas implementasi dicatat di [audit-instructions.md](audit-instructions.md).

## Prasyarat dan satu perintah deploy

Sediakan enam node Linux yang schedulable dan memiliki kernel terpisah. Contoh: satu K3s server sekaligus worker (`bnpb-a`) dan lima K3s agent (`bnpb-b` sampai `bnpb-f`). Konfigurasi default K3s menyediakan NetworkPolicy controller serta StorageClass `local-path` dengan `WaitForFirstConsumer`. Verifikasi disk lokal, binding PVC, dan node affinity PV setelah deploy. Provisioning/join VM merupakan prasyarat di luar command deploy aplikasi.

1. Ikuti setup node dan inventaris host di `petunjuk.md`.
2. Salin `k8s/full-stack.json.example` menjadi `k8s/full-stack.json`. Isi `context`, `imageRepository`, `imageTag`, `stableNodeName`, dan dua kelompok `storageNodes` yang tidak beririsan. Setiap kelompok mempunyai tiga node. Nilai memory Lampiran B sudah tersedia; CPU opsional.
3. Jalankan `python3 scripts/kubernetes/init-secrets.py` sekali. Berkas `.env.k8s` bermode `0600`; simpan cadangan privat. Token feed asli harus diisi sendiri jika feed diaktifkan.
4. Login registry melalui `docker login`. Untuk registry privat, buat namespace dan Secret tipe `kubernetes.io/dockerconfigjson` lebih dahulu; isi `imagePullSecret` dengan namanya. Secret tersebut digunakan seluruh workload dan Job.
5. Jalankan:

   ```bash
   KUBE_CONTEXT=bnpb-demo bash scripts/kubernetes/deploy-all.sh
   ```

Script membuat kubeconfig sementara untuk context eksplisit, melakukan preflight sebelum mutasi, merender manifest dari Compose, memvalidasi credential, build/push sembilan image, membuat namespace `sistem-informasi-kebencanaan-bnpb`, Secret, ConfigMap, RBAC pembacaan Pod topology, dan NetworkPolicy. Urutannya: anggota MongoDB → inisialisasi replica set → tunggu mongos → inisialisasi shard/user → migration → PostgreSQL/Kafka/Sensor Pantai → topik Kafka → aplikasi → pemeriksaan MongoDB/platform/isolasi/smoke API. Ia berhenti dengan exit nonzero bila tahap wajib gagal dan mencetak perintah diagnostik.

`BNPB_DEPLOY_CONFIG` dan `BNPB_DEPLOY_SECRETS` dapat menunjuk input alternatif. `SKIP_IMAGE_BUILD=1` memakai image yang sudah dipublikasikan; pastikan seluruh tag tersedia di semua node. Gunakan tag versi baru untuk setiap perubahan aplikasi. Job diberi nama berdasarkan hash spesifikasinya sehingga template Job yang berubah tidak berbenturan dengan objek immutable. Perubahan ConfigMap/Secret environment juga mengubah annotation hash Pod template agar workload menerima konfigurasi baru. Migration dan bootstrap tetap idempotent. Deploy ulang menolak perubahan Secret yang sudah ada; rotasi password memerlukan perubahan database yang sesuai, bukan sekadar mengganti Secret.

## Topologi dan partisi

| Node | Salinan data canonical | Komponen tambahan |
| --- | --- | --- |
| A | shard A, satu anggota | config server; singleton PostgreSQL, broker, sensor, API/consumer/mock |
| B | shard A, satu anggota | config server |
| C | shard A, satu anggota | config server |
| D | shard B, satu anggota | — |
| E | shard B, satu anggota | — |
| F | shard B, satu anggota | — |

Tiga Aggregator disebarkan merata pada hostname yang tersedia; router mongos juga tersebar dengan preferensi anti-affinity. Penempatan ordinal dalam satu kelompok dapat berubah; Audit API membaca `spec.nodeName` Pod aktual melalui Kubernetes API, bukan menebak node dari hostname MongoDB. Identitas unit tetap berupa replica set/host.

```text
                 Service Aggregator (stabil)
             /             |              \
       Aggregator       Aggregator      Aggregator
                    | mongos routers |
              +-----+----------------+-----+
              |                            |
       shard A: A/B/C                shard B: D/E/F
       3 voting data                 3 voting data
              \                            /
               config replica set: A/B/C
```

`hazard_events` dipartisi dengan hash `_id` yang deterministik dari `(source, sourceRefId)`; delapan chunk awal dan balancer MongoDB membagi ruang hash ke dua shard. Unique `_id` kompatibel dengan shard key; indeks `(source, sourceRefId)` bukan unique lintas shard. Setiap replica set mempunyai tiga anggota voting yang menyimpan data, tanpa arbiter. Majority write dengan journaling mempertahankan write yang sudah diakui saat satu anggota hilang; quorum tersisa dua.

Dengan data nonkosong pada kedua shard, A/B/C hanya menyimpan subset `D_A`, D/E/F hanya `D_B`. Untuk setiap node `n`, `D_n != D_A ∪ D_B`. Desain dua shard × tiga replika yang memakai node sama untuk kedua shard melanggar syarat ini. Enam node merupakan pilihan sederhana untuk mempertahankan dua shard dan tiga data replica tanpa overlap; bukan klaim jumlah minimum untuk semua algoritme/topologi.

Alternatif range `(wilayah,waktu)` memudahkan query wilayah tetapi menumpuk write ketika terjadi lonjakan di satu wilayah. Hash identifier stabil membagi lonjakan tersebut, dengan biaya scatter/gather untuk query waktu/wilayah. Rebalancing chunk tidak menggantikan penempatan replica set; penambahan mesin tetap memerlukan penyesuaian kelompok node dan penanganan volume lokal.

## Akses dan konsistensi

NodePort: Client API `30000`, Auth `30001`, Aggregator `30003`, dashboard `30004`, notifikasi `30005`. Halaman dashboard ada di `/dashboard`.

Audit memakai Bearer audit token. Endpoint internal aplikasi/analitik memakai `X-BNPB-Internal-Key`. Dashboard memperoleh angka canonical melalui `/internal/analytics` milik Aggregator; tabel daftar tetap projection Kafka. Dashboard tidak mengakses canonical database.

Pembacaan canonical memakai `secondaryPreferred`, collation byte `simple`, timeout, dan `allowPartialResults`. Hasil bisa tertinggal dari write terbaru; ini bukan snapshot lintas halaman atau read-your-write. Pagination memakai `(ingestedAt,hazardId)` menaik untuk audit dan `(occurredAt menurun,hazardId menaik)` untuk daftar terbaru; data yang berubah di tengah pagination tidak mempunyai jaminan snapshot. Bekukan input untuk pembuktian count/checksum. Jika cakupan unit berubah antarhalaman, cursor ditolak HTTP 400 dan klien harus mulai lagi. Satu replica mati dapat menghasilkan `partial=false` karena salinan sehat masih mencakup seluruh data; analitik menyertakan `degraded=true`. Seluruh shard tak terjangkau menghasilkan angka parsial dengan `unavailable_units`.

Router, Job bootstrap/migration menggunakan kelas `other` (`128Mi/256Mi`). `mongod` dan PostgreSQL memakai `store` (`512Mi/1Gi`), Kafka `broker` (`512Mi/1Gi`). Sensor memakai `role=sensor` dengan anggaran `other` sambil menunggu contoh YAML resmi. Tidak ada sidecar pada workload yang dirender. CPU tidak dideklarasikan pada output renderer; YAML MongoDB mandiri masih mempunyai CPU request 250m per mongod.

## Komponen P3/P4

- `field-report-processor` (`role=consumer`, 128Mi/256Mi) dan `fire-processor` (`role=broker` sebagai pemroses stream Lampiran B, 512Mi/1Gi) dirender seperti aplikasi lain. NetworkPolicy keduanya hanya mengizinkan egress ke Kafka dan Aggregator, sehingga Canonical Store hanya terjangkau lewat API Aggregator. `verify-isolation.sh` menguji hal ini.
- Client API mendapat egress ke Kafka untuk `POST /field-reports`. Job topik membuat `field-reports` dengan 3 partisi, RF 1, dan `retention.ms=2592000000`.
- Mapping PVMBG berada di ConfigMap `pvmbg-mapping` yang dipasang sebagai **direktori** (tanpa `subPath`) di `/app/config/pvmbg-mapping`. ConfigMap ini sengaja tidak ikut `bnpb/config-hash`, sehingga perubahannya dimuat ulang tanpa rollout (kubelet menyinkronkan dalam ±1 menit; status per replica di `GET /internal/pvmbg/mapping`). Mengubahnya:

  ```bash
  kubectl -n sistem-informasi-kebencanaan-bnpb create configmap pvmbg-mapping \n    --from-file=mapping.json=services/bnpb-aggregator/config/pvmbg-mapping/examples/m2-adjusted.json \n    --dry-run=client -o json | kubectl -n sistem-informasi-kebencanaan-bnpb apply -f -
  ```

  Deploy ulang mengembalikan isi ConfigMap ke file pada `pvmbgMappingFile` di config deploy (default `mapping.json` di repo).
- `fire-processor` saat ini hanya menjalankan engine dan endpoint health; consumer `satellite.raw` dan penulisan ke Aggregator belum ada (CP 3.4/3.5).

## Batas operasional

Cluster enam node belum tersedia pada audit ini. Kode observabilitas seluruh service dan pemulihan otomatis node/disk permanen belum memenuhi seluruh instruksi; lihat matriks audit. A merupakan satu control plane dan menampung singleton dependency. Uji worker lebih dahulu. Kehilangan A memerlukan pemulihan control plane serta store singleton dari cadangan; desain ini belum HA terhadap kehilangan A. Jangan menyimpulkan kelulusan semua skenario node dari replikasi MongoDB saja.

YAML MongoDB mandiri dan `deploy-mongo.sh` tetap merupakan jalur development saja. Keduanya tidak menerapkan pemisahan enam node yang dilakukan renderer full-stack, tidak memasang seluruh aplikasi, dan tidak membuktikan kepatuhan demo. Pakai entry point full-stack untuk penerimaan.
