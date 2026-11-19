# Instruksi Codex — Kubernetes dan Sharding BNPB M2

## Tujuan dan sumber acuan

Implementasikan kebutuhan Kubernetes dan sharding untuk IF4031 Milestone 2 pada repositori BNPB yang sedang dibuka. Hasil akhir harus dapat dijalankan dan diuji melalui entry point proyek serta memiliki bukti penerimaan yang dapat direproduksi.

Acuan utama adalah `IF4031 - Tugas Besar - M2.pdf`, khususnya Ketentuan Implementasi, Tester Agent, Problem 1, bagian Kubernetes dari Problem 2, serta Lampiran A dan B. `Panduan_Deploy_MongoDB_Kubernetes.md` menjadi konteks deployment lama. Saat ada perbedaan, ikuti spesifikasi M2.

Dokumen ini adalah instruksi pekerjaan. Status implementasi harus ditentukan dari kode, manifest, script, dan hasil uji aktual di repo. Nama file dari panduan lama perlu dicocokkan dengan isi repo.

## Batas pekerjaan

- Migrasikan seluruh komponen BNPB ke Kubernetes, termasuk dependency yang diperlukan agar stack berjalan end-to-end. Inventarisasi Aggregator, canonical store, database service lain, broker, consumer, Auth, Client API, dashboard, observabilitas, mock, dan Sensor Pantai berdasarkan arsitektur aktual.
- Implementasikan partisi data, replikasi, pembacaan lintas shard, penanganan hasil parsial, pemulihan disk kosong, dan distribusi ulang data atau replika yang diperlukan P1.
- Lengkapi penempatan, readiness, scaling, rolling update, dan konfigurasi Aggregator yang diperlukan P2. Perubahan kode koordinasi dan penyimpanan dibatasi pada dependensi yang diperlukan agar scaling dan failover aman.
- Hubungkan Audit API, dashboard analitik, dan observabilitas dengan penyimpanan terdistribusi agar hasil sharding bisa diverifikasi.
- Pertahankan kontrak dan perilaku aplikasi M1 yang masih berlaku. Implementasi algoritme kebakaran, kebijakan perubahan skema, atau logika domain Sensor Pantai dikerjakan sejauh diperlukan untuk integrasi Kubernetes dan pembuktian sharding.
- Gunakan ulang teknologi dan mekanisme yang sudah memenuhi spesifikasi. MongoDB pada panduan lama menjadi titik awal evaluasi. Perubahan strategi storage harus memiliki alasan yang diturunkan dari hasil evaluasi.

## 1. Audit repo sebelum mengubah kode

1. Baca `AGENTS.md` yang berlaku, README, spesifikasi yang tersedia di repo, file Compose, `.env.example`, Dockerfile, manifest `k8s/`, script deployment dan recovery, serta kode akses canonical store.
2. Petakan setiap komponen ke image, port, dependency, credential, konfigurasi, volume, health endpoint, role, dan kelas sumber daya.
3. Periksa `k8s/mongo.yaml`, `k8s/migrate.yaml`, `deploy-mongo.sh`, `verify-mongo.sh`, dan Job replica-init/sharding-init jika ada. Pastikan urutan aktualnya dapat bekerja.
4. Identifikasi hardcode `docker-desktop`, namespace `bnpb`, StorageClass, hostname node, IP, credential, `localhost`, dan asumsi image lokal yang menghambat cluster demo.
5. Buat ringkasan gap terhadap kriteria di bawah. Lanjutkan mengimplementasikan gap yang bisa diselesaikan dalam repo. Jika resource eksternal belum tersedia, siapkan implementasi dan prosedur uji serta nyatakan bagian yang belum terverifikasi.

## 2. Kontrak platform Kubernetes

### Cluster dan penempatan

- Seluruh komponen aplikasi BNPB berjalan dalam namespace **`sistem-informasi-kebencanaan-bnpb`**. Gunakan namespace ini secara konsisten pada manifest, script, DNS service, pemeriksaan, observabilitas, dan contoh README.
- Demo memakai minimal dua node dengan kernel terpisah. VM Linux, Linux native, atau gabungannya diperbolehkan. kind/k3d/minikube dengan kernel bersama dapat menjadi lingkungan development.
- Baseline Aggregator membutuhkan setidaknya tiga instance pada node berbeda. Rencanakan minimal tiga node yang dapat menjalankan workload untuk memenuhi baseline ini. Jumlah node storage ditentukan lagi oleh batas penempatan dan kebutuhan replikasi P1.
- Pada topologi dua node, A menjadi control plane sekaligus worker dan B menjadi worker. Gangguan node hanya menyasar worker non-control-plane. Untuk topologi tiga node atau lebih, spesifikasi mengizinkan gangguan pada node mana pun. Deklarasikan skenario serta konsekuensi pemulihan control plane yang benar-benar didukung.
- README mencantumkan jumlah node, jenis tiap node, host fisik masing-masing, dan CPU/RAM setiap host. Tambahkan alokasi VM, nama node, IP/jaringan, serta kapasitas disk agar langkah deployment dapat diikuti.
- Verifikasi bahwa node yang direncanakan menerima Pod memang schedulable, cukup kapasitas, dan memiliki label yang benar.

### Resources dan label

Setiap Pod aplikasi wajib memiliki label `role` yang sesuai dari daftar berikut. Deklarasikan memory requests dan limits sesuai Lampiran B. Alokasi CPU bersifat opsional menurut catatan Lampiran B. Jika CPU dideklarasikan, dokumentasikan nilainya.

| Komponen | Label `role` | Memory request | Memory limit |
| --- | --- | --- | --- |
| Aggregator | `aggregator` | `256Mi` | `512Mi` |
| Penyimpanan per instance | `store` | `512Mi` | `1Gi` |
| Broker atau pemroses stream per instance | `broker` | `512Mi` | `1Gi` |
| Consumer atau pemroses event | `consumer` | `128Mi` | `256Mi` |
| Auth dan Client-Facing API | `api` | `128Mi` | `256Mi` |
| Mock BMKG/PVMBG | `mock` | `64Mi` | `128Mi` |
| Komponen lain | `other` | `128Mi` | `256Mi` |

- Gunakan `role=sensor` untuk Sensor Pantai. Cocokkan resource-nya dengan contoh manifest resmi. Jika tidak ada kelas lebih spesifik, dokumentasikan pemetaan ke kelas komponen lain. Cuplikan PDF yang tersedia menyebut contoh manifest Sensor Pantai tetapi tidak menampilkan YAML tersebut.
- Dokumentasikan klasifikasi router `mongos`, bootstrap Job, sidecar, dan komponen observabilitas sesuai fungsi aktualnya. Tetapkan anggaran per Pod secara konsisten jika ada beberapa container, dan pastikan seluruh container yang menyumbang konsumsi resource diperhitungkan.
- Pengecualian eksplisit berlaku untuk Tester Agent. Pertahankan hak dan resource manifest asisten. Alat load testing mengikuti ketentuan terpisah pada Lampiran B dan dijalankan di luar Pod komponen aplikasi.

### Secret, ConfigMap, dan ownership storage

- Simpan password database, internal cluster key, registry credential, token audit, token feed, dan token Sensor Pantai sebagai Secret. Simpan konfigurasi aplikasi sebagai ConfigMap. Pertahankan `.env.example` untuk pengembangan lokal dengan placeholder yang dapat dipahami.
- Script dapat menerima credential dari environment atau secret file yang didokumentasikan. Hindari mencetak nilai rahasia dan pertahankan credential saat deploy ulang pada volume lama.
- Tegakkan akses storage hanya untuk service pemilik melalui NetworkPolicy yang diterapkan oleh jaringan cluster. Izinkan komunikasi internal database serta bootstrap/migration yang memang dibutuhkan.
- Verifikasi bahwa client service lain gagal membuka koneksi ke Service dan IP Pod database, sedangkan pemilik berhasil. RBAC untuk Kubernetes API dan password database dapat menjadi lapisan tambahan.
- Petakan DNS, broker, observabilitas, traffic aplikasi, dan traffic database yang perlu diizinkan agar policy tidak merusak jalur yang sah. Pertahankan kemampuan Tester Agent melakukan gangguan sesuai manifest resminya.
- Dashboard dan API memperoleh data canonical melalui service pemilik, sesuai kontrak ownership storage M1 yang ditemukan di repo.

### Persistent storage lokal

- Seluruh data komponen `role=store` disimpan pada disk node tempat Pod berjalan, menggunakan local PV atau hostPath sesuai kontrak Tester Agent. Evaluasi provisioner local-path berdasarkan backing disk dan node affinity aktual.
- Atur node affinity dan binding PVC/PV agar storage tetap terikat pada node yang benar. Data stateful harus bertahan saat Pod restart pada node sehat.
- Implementasikan pemulihan jika node hilang permanen beserta disk-nya. Pod baru pada node lain harus mendapat volume lokal yang sesuai dan memulihkan data dari replika yang masih hidup.
- Dokumentasikan reclaim policy serta mekanisme penanganan PVC/PV yang masih terikat pada node hilang. Periksa status replikasi sebelum operasi penggantian volume.

## 3. Deployment satu perintah

Sediakan satu entry point untuk deploy seluruh stack, misalnya `make deploy CONTEXT=bnpb-demo`. Gunakan pola yang paling sesuai dengan repo. README wajib menjelaskan prasyarat, input, dan command yang persis dapat dijalankan.

1. Periksa context, akses cluster, node, kapasitas, storage lokal, image, dan credential yang diperlukan.
2. Buat namespace, Secret, ConfigMap, policy, dan resource infrastruktur aplikasi.
3. Deploy dependency stateful beserta konfigurasi replikasinya. Tunggu kondisi yang benar-benar dibutuhkan setiap tahap.
4. Jalankan inisialisasi replica set, pendaftaran shard, pembuatan akun, dan migration sesuai dependency aktual. Router yang dibutuhkan Job sharding harus sudah dapat menerima koneksi sebelum Job tersebut berjalan. Hindari siklus readiness yang menunggu konfigurasi yang justru dibuat Job berikutnya.
5. Deploy seluruh service aplikasi, titik masuk, dashboard, dan observabilitas. Tunggu kesiapan, lalu jalankan smoke check.
6. Berikan exit code gagal jika tahap wajib gagal, beserta nama resource dan petunjuk log yang relevan. Tetapkan timeout agar command selesai dengan hasil yang jelas.

Kriteria penerimaan deployment:

- Satu perintah berhasil pada cluster siap pakai dengan input yang didokumentasikan, tanpa edit YAML manual di tengah proses.
- Provisioning VM dan pemasangan/join k3s dapat menjadi prasyarat yang didokumentasikan. Ini merupakan interpretasi operasional ketentuan satu perintah deploy sistem. Tampilkan batas prasyarat tersebut di README.
- Image seluruh service tersedia untuk semua node melalui registry atau mekanisme distribusi image yang terdokumentasi. Secret untuk registry privat dibuat di namespace yang tepat.
- Deploy ulang mempertahankan data dan credential. Job selesai ditangani sesuai versinya. Migration baru dapat dijalankan tanpa benturan immutable Job template dan tanpa reinitialize replica set.
- Environment development dan demo memakai konfigurasi bersama sebanyak mungkin. Perbedaan context, storage, dan ingress dapat dikelola dengan parameter, Helm, atau Kustomize sesuai kebutuhan repo.
- Script menerima context tujuan yang eksplisit dan memeriksa cluster sebelum menulis resource. Sesuaikan pengecekan `docker-desktop` pada panduan lama agar cluster demo dapat dipakai.

## 4. Sharding dan replikasi — Problem 1

### 4.1 Tetapkan topologi yang memenuhi penempatan data

- Tentukan shard key atau mekanisme partisi, jumlah shard, faktor replikasi, anggota voting, penempatan primary/replica, serta failure domain berdasarkan node.
- Hitung himpunan **HazardEvent unik yang secara fisik tersimpan di tiap node**, termasuk replika. Kriteria P1.1 melarang satu node menyimpan seluruh dataset. Pelaporan primary saja belum membuktikan syarat ini.
- Periksa desain lama dua data shard × tiga replika pada tiga node. Jika setiap node memiliki satu replika lengkap dari setiap shard, gabungannya mencakup seluruh dataset di setiap node. Desain itu perlu disesuaikan untuk memenuhi P1.1.
- Bedakan jumlah Pod, replica set, shard, node Kubernetes, dan kernel. Menambah Pod pada node yang sama tidak menambah failure domain.
- Pilih jumlah node dan penempatan shard yang sekaligus memenuhi sebaran data, kehilangan satu node, quorum/election, write durability, dan penambahan node. Jelaskan hasil perhitungan sebelum mengunci manifest. Jika perlu lebih dari tiga node, tunjukkan alasan teknisnya.
- Gunakan topologi aktual saat menyatakan primary dan replika pada Audit API. Arbiters, bila digunakan, tidak dihitung sebagai salinan data.

### 4.2 Distribusi dan skew

- Muat katalog gempa historis dari asisten melalui jalur ingestion yang didokumentasikan.
- Ukur record unik, primary ownership, salinan replika, ukuran data, laju penulisan, CPU, memory, dan latensi per node/shard saat import.
- Jalankan lonjakan gempa pada satu wilayah. Bandingkan distribusi dan beban sebelum, selama, dan setelah lonjakan.
- Pertimbangkan setidaknya dua pendekatan partisi, misalnya range berdasarkan wilayah/waktu dan hash atas identifier stabil. Pilih berdasarkan pola akses, skew, kebutuhan query global, dan mekanisme rebalancing.
- Jika memakai MongoDB sharded collection, periksa chunk/range dan dokumen aktual di setiap shard. Pastikan data benar-benar tersebar dan penulisan melibatkan lebih dari satu node.
- Pastikan aturan deduplikasi dan uniqueness kompatibel dengan shard key serta mekanisme indeks database yang dipakai.

### 4.3 Query global dan hasil parsial

- Sediakan pembacaan lintas seluruh shard untuk event terbaru lintas hazard type, misalnya 50 event dengan pagination. Tetapkan urutan deterministik dan tie-breaker yang stabil.
- Nyatakan konsistensi tiap endpoint pada kondisi normal, failover, serta perubahan data selama pagination. Pertahankan semantik cursor tanpa menghilangkan atau menggandakan hasil pada kondisi uji yang dinyatakan.
- Terapkan timeout koneksi dan query. Unit yang tidak terjangkau harus menghasilkan respons terbatas waktu dengan `partial: true` dan `unavailable_units` sesuai Lampiran A.
- Pilih jalur partial read yang benar-benar bekerja dengan database, router, driver, read preference, dan query aktual. Uji saat satu shard benar-benar tidak dapat dijangkau. Replikasi yang sehat dapat membuat hasil tetap lengkap pada sebagian skenario node mati.
- Jika hasil lengkap tersedia melalui replica yang sehat, laporkan kelengkapan secara jujur. Untuk dashboard analitik, sertakan penanda node gagal/kondisi terdegradasi saat node mati, serta tandai ketidaklengkapan angka sesuai tuntutan P1.7.
- Audit checksum dan angka parsial harus menunjukkan bahwa cakupannya belum lengkap. Pertahankan kontrak JSON dan identitas unit yang konsisten selama recovery.

### 4.4 Kehilangan node, disk kosong, dan recovery

- Deklarasikan write concern/acknowledgement dan replikasi yang menjaga HazardEvent yang sudah diakui tetap ada setelah satu node beserta disk-nya hilang.
- Pastikan config server, metadata penempatan, router, credential, dan dependensi write path memiliki strategi pemulihan yang sesuai. Analisis quorum tiap replica set.
- Uji node worker mati dengan seluruh disk data target terhapus. Selama pemulihan, request tetap mendapat jawaban lengkap atau parsial dalam batas waktu yang dinyatakan, sesuai P1.4.
- Tambahkan node baru atau node dengan disk kosong. Pastikan Pod, local volume, keanggotaan replica set/shard, dan aliran data diperbarui sesuai mekanisme desain.
- Buktikan node baru menanggung data serta beban aktual sambil baca/tulis berlangsung. `kubectl get nodes` dan restart Pod saja belum membuktikan P1.5.
- Setelah sinkronisasi dan rebalancing, buktikan sistem kembali tahan kehilangan satu node berikutnya. Periksa replika sehat, penempatan antarnode, checksum, dan ulangi kehilangan worker lain sebagai bukti.
- Selama window pemulihan game day, recovery berjalan otomatis sesuai P5.6. Pisahkan langkah penyediaan/join mesin baru yang dipicu skenario P1.5 dari tindakan repair yang semestinya otomatis.

### 4.5 Audit API untuk pembuktian

Expose endpoint audit melalui titik masuk Aggregator dengan `Authorization: Bearer <audit-token>` dari Secret. Gunakan JSON, timestamp ISO 8601 UTC, dan nama field persis Lampiran A.

| Endpoint | Kontrak yang wajib dijaga |
| --- | --- |
| `GET /internal/audit/events` | Parameter `source`, `since`, `limit`, `cursor`. `since` memfilter `ingested_at >= since`. Semua field HazardEvent dikembalikan. Urutan menaik `ingested_at`, lalu `hazard_id`. Respons `items`, `next_cursor`, `partial`, `unavailable_units`. |
| `GET /internal/audit/checksum` | Parameter `source`. Respons `source`, `count`, `checksum`, `algorithm`, `as_of`, `partial`, `unavailable_units`. SHA-256 dari seluruh `source_ref_id` terurut byte ascending, dipisahkan newline tanpa newline terakhir, hex lowercase 64 karakter. Hitung record logis sekali, terlepas dari jumlah replika. |
| `GET /internal/audit/location` | Parameter wajib `hazard_id`. Respons `hazard_id`, `locations`, `partial`. Setiap lokasi memakai `node` aktual dari `kubectl get nodes`, `unit`, dan `role` bernilai `primary` atau `replica`. 404 jika event memang tidak ditemukan. |

- `source` yang tidak diberikan berarti semua sumber sesuai kontrak. Limit default 100, maksimum 1000 untuk endpoint daftar yang menggunakannya. Cursor buram berasal dari `next_cursor`, bernilai null pada halaman terakhir.
- Pertahankan `detection_keys` asli tanpa pembulatan. Pertahankan endpoint `/internal/audit/unprocessed` yang sudah ada ketika jalur storage berubah. Pengembangan bisnis DLQ di luar kebutuhan integrasi ini mengikuti pekerjaan P3.
- Error HTTP 400/401/403/404/429/503 mengikuti bentuk `{"error":{"code":"...","message":"..."}}`. Bedakan event yang tidak ditemukan dari kegagalan mengakses unit yang mungkin menyimpannya.

### 4.6 Dashboard analitik dan metrik

- Dashboard analitik browser menghitung seluruh HazardEvent lintas lokasi storage, termasuk EARTHQUAKE, TSUNAMI, VOLCANO atau enum aktual proyek yang setara, WILDFIRE, dan COASTAL.
- Tampilkan line chart jumlah per jenis bahaya terhadap waktu dengan pemilih rentang waktu, jumlah per severity, dan jumlah per `area_name` berupa chart atau tabel.
- Angka agregat harus cocok dengan perhitungan dari Audit API pada cakupan data/waktu yang sama. Tampilkan partial/unavailable dan status degradasi saat kehilangan node.
- Dashboard metrik menyediakan latensi, error rate, throughput tiap service, ditambah distribusi storage/write, replication lag, status shard, dan progres recovery yang diperlukan pembuktian P1.
- Pertahankan trace satu alur lintas service beserta durasi tiap langkah dan log terstruktur ber-correlation ID.

## 5. Aggregator di Kubernetes — bagian Problem 2

- Baseline minimal tiga instance pada node berbeda, di belakang satu titik masuk stabil. Gunakan scheduling constraint yang dapat dibuktikan dari Pod-to-node mapping.
- Readiness harus mewakili kemampuan melayani request. Service/ingress berhenti mengarahkan request baru ke Pod tidak sehat setelah deteksi dan pembaruan endpoint. Ukur waktu deteksinya.
- Sediakan startup/liveness probe sesuai lifecycle aplikasi, graceful termination, dan drain koneksi untuk rolling update.
- Sediakan konfigurasi serta uji rolling update versi Aggregator selama load test tanpa request gagal, sesuai P2.8. Pastikan kapasitas sementara untuk rollout tersedia.
- Dukung skala `3 → 5 → 2` selama load test. Aturan satu Pod per node secara wajib perlu dievaluasi karena lima replika memerlukan lima node jika aturan itu diberlakukan untuk semua replika. Pilih jumlah node atau aturan penyebaran yang memenuhi baseline dan skenario scaling, lalu nyatakan kebijakannya.
- Kubernetes replica count dan Service perlu diintegrasikan dengan koordinasi ingestion. Evaluasi mekanisme single owner, takeover, fencing, deduplikasi, dan persistence cursor yang sudah ada.
- Uji owner mati dengan takeover ≤60 detik, clock skew +45 lalu −30 detik, serta freeze lebih lama dari lease lalu resume. Instance lama harus kehilangan hak commit sampai statusnya diperbarui. Pastikan upstream tidak menerima polling berlipat dan HazardEvent tidak double.
- Sertakan load test ≥10.000 VU selama ≥120 detik, error rate di luar penolakan terkontrol <1%, dan throughput tiga instance ≥2,0× satu instance. Gunakan generator beban di luar Pod aplikasi serta catat resource dan kondisi pengujiannya.
- Jika implementasi koordinasi di luar cakupan perubahan ini belum siap, nyatakan kriterianya sebagai belum lulus. Manifest dengan tiga replika hanya membuktikan bagian penempatan.

## 6. Kontrak Tester Agent

Pasang manifest resmi pada cluster demo. Gunakan image persis yang diberikan asisten dan pertahankan seluruh hak yang diminta.

```bash
kubectl apply -f https://raw.githubusercontent.com/susTuna/if4031-tester-agent/ebb55261711123a9a211739ffbf140a275caa6da/manifest.yaml
```

Image wajib sesuai spesifikasi:

```text
sustuna/tester-agent@sha256:b3143da159cf23a8744ede12b847da6208353754234d53a5a7b46d071cf277ec
```

- Manifest memasang satu Pod Tester Agent per node. Namespace Tester Agent terpisah dari namespace aplikasi.
- Pastikan RBAC, NetworkPolicy, Pod Security, taint, dan resource policy mengizinkan seluruh aksi Tester Agent yang diminta manifest. Image wajib tetap sama dan Tester Agent tetap berjalan selama pengujian.
- Periksa daftar skenario latihan dan jalankan skenario yang relevan terhadap node/storage/Aggregator.

```bash
kubectl exec -n tester-agent daemonset/tester-agent -- /app list
kubectl exec -n tester-agent daemonset/tester-agent -- /app run practice <nama-skenario-dari-list>
kubectl -n tester-agent get pods -o wide
kubectl -n tester-agent logs <nama-pod-tester-agent-pada-node-target>
```

- Gunakan nama skenario yang benar-benar muncul dari `/app list`. Kunci ujian berasal dari asisten. Catat gangguan yang memerlukan tindakan eksternal seperti freeze VM di prosedur demo.
- Sensor Pantai adalah dependency aplikasi dalam cluster. Jika termasuk inventaris yang dimigrasikan, gunakan image resmi `sustuna/sensor-pantai@sha256:51fbd90d3891ad6e9f5768ad330ffb65205644cb29e50da65c7538f2e0b4397d`, `role=sensor`, token dari Secret, dan kontrak Lampiran C.

## 7. Matriks penerimaan dan bukti

| ID | Sumber | Kondisi lulus dan bukti minimum |
| --- | --- | --- |
| K01 | Platform 1–4, P2.1 | Inventaris seluruh komponen ada di Kubernetes. Deklarasi demo dan bukti kernel terpisah tersedia. Tiga Aggregator baseline berada di node berbeda. |
| K02 | Platform 5 | Deploy dari cluster siap pakai melalui satu command README. Log menunjukkan bootstrap hingga smoke test selesai. |
| K03 | Platform 6, Lampiran B | Pemeriksaan manifest dan Pod aktual menunjukkan role serta memory request/limit yang sesuai. |
| K04 | Platform 7–8 | Secret/ConfigMap dan `.env.example` lengkap. Uji koneksi pemilik ke storage berhasil dan service lain ditolak oleh platform. |
| K05 | Tester Agent 1–8 | Agent berjalan per node dengan image resmi. Storage lokal dapat dibuktikan dan skenario latihan dapat dieksekusi. |
| S01 | P1.1 | Import katalog selesai. Inventaris data fisik termasuk replika membuktikan tiap node menyimpan subset, serta data dan beban tulis tersebar. |
| S02 | P1.2 | Metrik per node/shard tersedia untuk import dan lonjakan satu wilayah. Hasil menggambarkan skew dan efek mekanisme partisi. |
| S03 | P1.3 | Query global berpagination terurut benar pada dataset uji lintas shard. |
| S04 | P1.4, Lampiran A | Node worker dan disk target hilang. Request tetap selesai lengkap/parsial. Sesudah pulih count/checksum cocok dengan referensi asisten. |
| S05 | P1.5 | Node baru/disk kosong ikut menyimpan data dan menerima beban sambil baca/tulis tetap berlangsung. |
| S06 | P1.6 | Setelah recovery, salinan dan quorum sehat kembali. Uji kehilangan worker berikutnya menjaga data. |
| S07 | P1.7 | Dashboard analitik tiga visual wajib cocok dengan Audit API dan menunjukkan degradasi/ketidaklengkapan saat gangguan. |
| A01 | P2.1 | Satu titik masuk, tiga Pod pada node berbeda, dan uji readiness membuktikan routing hanya ke instance siap. |
| A02 | P2.2–5 | Ingestion tunggal, takeover ≤60 detik, clock skew, dan freeze/resume lulus bersama bukti upstream serta storage. |
| A03 | P2.6–8 | Load test, skala 3→5→2, rasio throughput, dan update versi memenuhi angka serta batas error di spesifikasi. |

Untuk setiap baris, catat status `lulus`, `gagal`, atau `belum diuji`, command, prasyarat, hasil aktual, dan lokasi bukti. Jika dataset/token asisten belum tersedia, gunakan fixture lokal untuk verifikasi awal dan tandai uji referensi asisten sebagai belum diuji.

## 8. Dokumentasi dan penyelesaian

- Perbarui README dengan setup dari kondisi awal, deklarasi topologi, entry point deploy, daftar konfigurasi, registry access, storage lokal, akses dashboard/API, serta cara memicu dan mengamati setiap skenario di cakupan ini.
- Sertakan diagram deployment komponen per node dan jalur data antarnode. Dokumentasikan penempatan setiap salinan shard agar syarat tidak ada node menyimpan seluruh data dapat diperiksa.
- Dokumentasikan mekanisme partisi/replikasi/rebalancing, minimal dua alternatif dan trade-off skew, konsistensi tiap endpoint, strategi partial result, dan recovery node/disk untuk bagian laporan P1.
- Dokumentasikan readiness, scaling, rollout, serta dependensi koordinasi ingestion untuk bagian laporan P2 yang relevan.
- Sediakan script pemeriksaan namespace/role/resource, ownership storage, distribusi data, checksum, pagination, dan recovery. Gunakan ulang tester dan alat proyek yang sudah ada.
- Jalankan validasi manifest, pemeriksaan script, build komponen yang berubah, smoke test, dan skenario integrasi yang relevan. Lengkapi bukti runtime dengan nama node dan waktu pengujian.
- Sebelum selesai, laporkan file yang berubah, command deploy yang dapat dipakai, hasil matriks penerimaan, asumsi desain, serta dependensi eksternal yang masih menghalangi pengujian. Klaim kepatuhan demo harus didukung uji pada cluster dengan kernel terpisah.

