# SCHEMA_POLICY — kebijakan perubahan skema PVMBG

Deklarasi resmi untuk P3 kriteria #1 (bahan laporan "Di laporan (2)"). Kebijakan ini berangkat dari D-05 dan validator Tahap 1. Perubahan terhadap Tahap 1 ditandai **(perubahan T4)**. Setiap baris tabel § 2 dibuktikan oleh tepat satu unit test bernama `SCHEMA_POLICY#<id>` di `services/bnpb-aggregator/tests/libs/schema-policy.test.ts`.

Path kode relatif terhadap `services/bnpb-aggregator/`.

## 1. Kontrak VolcanicReport → HazardEvent

| Field | Wajib | Tipe | Batasan | Dipetakan ke HazardEvent |
|---|---|---|---|---|
| `report_id` | ya (tidak bisa dilonggarkan) | string | 1–256 karakter | `source_ref_id`; `hazard_id = uuidv5([PVMBG, report_id])` |
| `volcano_id` | ya (tidak bisa dilonggarkan) | string | 1–128; harus ada di tabel referensi BNPB `VOLCANO_LOCATIONS` (`src/constants/volcano-locations.ts`) | `area_name`, `latitude`, `longitude` dari tabel referensi |
| `alert_level` | ya (tidak bisa dilonggarkan) | string enum | `Normal\|Waspada\|Siaga\|Awas` | `severity` (`NORMAL\|WASPADA\|SIAGA\|AWAS`) |
| `reported_at` | ya (tidak bisa dilonggarkan) | string | ISO 8601 dengan offset | `occurred_at`; juga awal `version` (D-32) |
| `eruption_count_24h` | ya (boleh dilonggarkan lewat config) | integer | ≥ 0 | `attributes.eruption_count_24h` |
| `ash_column_height_m` | ya (boleh dilonggarkan lewat config) | number | ≥ 0 | `attributes.ash_column_height_m` |
| `confidence_level` | tidak (v2) | number atau `null` | 0–1 | `attributes.confidence_level` (nilai dibawa apa adanya, termasuk `null`) |
| field lain | — | apa saja | — | `attributes.<nama>` (tolerant reader) |

Selain itu, `hazard_type = VOLCANIC`, `source = PVMBG`, dan `ingested_at` = waktu tulis di Aggregator.

Implementasi:
- skema: `src/clients/pvmbg.schema.ts`;
- pemetaan murni: `mapVolcanicReport` di `src/libs/pvmbg-mapping.ts`, dipakai oleh jalur poll maupun replay (`src/services/hazard-event-ingestion.service.ts`, `ingestVolcanicRecord`).

## 2. Tabel deklarasi perubahan

Kolom "pulih lewat config" berarti pesan yang terparkir bisa diproses ulang (replay, § 3) setelah file mapping diubah, tanpa build ulang.

| id (= nama test) | Jenis perubahan | Contoh | Perlakuan | Kategori | Contoh reason persis | Retryable | Pulih lewat config? |
|---|---|---|---|---|---|---|---|
| `additive_optional_field` | Field opsional baru | `observer: "Pos Babadan"`, `confidence_level` (v2) | diterima otomatis | — | — | — | tidak perlu |
| `field_order_changed` | Urutan field berubah | field dalam urutan terbalik | diterima otomatis | — | — | — | tidak perlu |
| `optional_field_null_or_missing` | Field opsional `null`/hilang | `confidence_level: null` | diterima otomatis (perubahan T4: `null` dulu ditolak) | — | — | — | tidak perlu |
| `rename_mapped_field` | Rename field yang dipetakan | `alert_level` → `level` (mock `rename_field`) | parked | `schema_incompatible` | `schema_incompatible: field wajib 'alert_level' hilang (kemungkinan di-rename menjadi 'level')` | false | **ya**: `aliases.alert_level = ["level"]` |
| `type_change_mapped_field` | Tipe field yang dipetakan berubah | `alert_level: 2` (mock `type_change`); `eruption_count_24h: "4"` | parked | `schema_incompatible` | `schema_incompatible: field 'alert_level' berubah dari string (enum Normal\|Waspada\|Siaga\|Awas) menjadi number` (perubahan T4: teks enum) | false | **ya**: `coercions.alert_level = {from:"number", table:{"0":"Normal",…,"3":"Awas"}}`; `coercions.eruption_count_24h = {from:"string", to:"integer"}` |
| `missing_required_tolerable` | Field wajib yang bisa ditoleransi hilang | tanpa `eruption_count_24h` (mock `missing_required`) | parked | `schema_incompatible` | `schema_incompatible: field wajib 'eruption_count_24h' hilang` | false | **ya**: keluarkan dari `required`. Attribute tersebut lalu tidak ada di HazardEvent |
| `missing_required_report_id` | `report_id` hilang | tanpa `report_id` | parked | `schema_incompatible` | `schema_incompatible: field wajib 'report_id' hilang` | false | **tidak** (pulih hanya lewat perubahan kode). Tanpa `report_id` tidak ada identitas, sehingga setiap kiriman ulang menjadi HazardEvent baru (duplikat). File mapping yang mengeluarkannya dari `required` ditolak |
| `unknown_enum_value` | Nilai enum tak dikenal | `alert_level: "Bahaya"` | parked | `validation_failed` | `validation_failed: field 'alert_level' bernilai "Bahaya" di luar nilai yang dikenal (Normal\|Waspada\|Siaga\|Awas)` | false | **ya**: tabel nilai `{from:"string", table:{"Bahaya":"Awas"}}` |
| `unknown_volcano_id` | `volcano_id` tak dikenal | `GUNUNG_FIKTIF` | parked | `validation_failed` | `validation_failed: volcano_id 'GUNUNG_FIKTIF' tidak ada di tabel referensi BNPB` | false | sebagian: kode lama yang berganti nama → tabel nilai `volcano_id`. Gunung baru → **tidak** (butuh data referensi/koordinat BNPB di kode) |
| `reported_at_not_iso` | `reported_at` bukan ISO | `"20/11/2026 10:00"` | parked | `validation_failed` | `validation_failed: field 'reported_at' tidak sesuai format datetime` | false | **tidak** (tidak ada koersi format tanggal; menebak format = risiko salah waktu) |
| `envelope_not_array` | Envelope bukan array/`{data:[…]}` | `{"reports":[…]}` | seluruh body parked (D-34) | `schema_incompatible` | `schema_incompatible: respons harus berupa array atau objek dengan array 'data'` | false | **tidak** (envelope ada di kode klien) |
| `canonical_and_alias_both_present` | Field kanonik dan aliasnya sama-sama ada | `alert_level:"Siaga"` + `level:"Awas"` dengan alias `level` | diterima: **kanonik menang**, alias masuk `attributes.level`, log warn + `pvmbg_mapping_alias_conflicts_total` | — | — | — | tidak perlu |
| `report_id_conflict` | (field report) `report_id` sama, isi berbeda | kirim ulang dengan `description` lain | yang pertama menang; kiriman berikutnya parked | `conflict` (baru T4) | `conflict: report_id <uuid> sudah ada dengan isi berbeda (sha256 <tersimpan> vs <masuk>)` | false | **tidak** (keputusan bisnis: kirim dengan `report_id` baru) |
| `malformed_truncated` | JSON terpotong | mock `malformed truncated` | seluruh body parked + checkpoint ditahan (D-34) | `malformed_json` | `malformed_json: JSON terpotong (Unexpected end of JSON input)` | false | tidak relevan: data diambil ulang dari sumber pada poll berikutnya |
| `malformed_deep_nesting` | Nesting sangat dalam | `{"data":[[[[…10.000…]]]]}` | seluruh body parked + ditahan; tidak pernah di-parse | `nesting_too_deep` | `nesting_too_deep: kedalaman nesting melebihi 64 pada offset 71` | false | idem |
| `malformed_invalid_utf8` | UTF-8 tidak valid | byte `C3 28` | seluruh body parked + ditahan | `invalid_utf8` | `invalid_utf8: byte UTF-8 tidak valid pada offset 27` | false | idem |
| `malformed_oversized` | Ukuran berlebih | body 12 MiB > `PVMBG_MAX_BODY_BYTES` (5 MiB) | dibaca sampai batas lalu di-stream ke GridFS, seluruh body parked + ditahan | `payload_too_large` | `payload_too_large: ukuran 12582912 byte melebihi batas 5242880 byte` | false | idem (atau naikkan `PVMBG_MAX_BODY_BYTES`, env) |
| `body_failure_window_skipped` | K body rusak berturut-turut (D-34, D-44) | 5 respons rusak beruntun | cursor `checkpointAt` dipaksa maju, tetapi status PVMBG tetap `STALE` dan `lastSuccessfulPollAt` tidak berubah sampai body valid diterima; jendela dicatat sebagai entri tersendiri berstatus `retrying` | `window_skipped` (baru T4, retryable sejak D-44) | `window_skipped: jendela poll [<since>, <until>) dilewati setelah 5 body rusak berturut-turut; diisi ulang retry worker dengan since=<since>` | true | **ya, otomatis**: retry worker memoll ulang `GET /volcanic-reports?since=<since>` lewat jalur ingest biasa. Percobaan habis selama sumber masih rusak → `retry_exhausted`, lalu replay manual |

Berbeda dengan semua baris di atas, kegagalan **sementara** (timeout, koneksi, HTTP 5xx/429/408, store tidak terjangkau) berstatus `retrying` dan dicoba ulang otomatis oleh retry worker dengan backoff. Kegagalan ini tidak butuh perubahan sistem (P3 #2; taksonomi di `src/libs/processing-error.ts`).

## 3. Apa yang termasuk "penyesuaian sistem"

**Lewat config** (tanpa build; file `config/pvmbg-mapping/mapping.json`, path dari `PVMBG_MAPPING_PATH`, dibaca ulang di setiap replica saat hash isinya berubah, D-36):

| Kunci | Arti | Contoh |
|---|---|---|
| `aliases` | nama lama → nama kanonik (rename). Kalau kanonik ada, kanonik menang | `{"alert_level": ["level"]}` |
| `coercions` dengan `table` | nilai → nilai, hanya bila tipe nilai = `from`. Nilai di luar tabel → `validation_failed` | `{"alert_level": {"from":"number","table":{"0":"Normal","1":"Waspada","2":"Siaga","3":"Awas"}}}` |
| `coercions` dengan `to` | string angka → `integer`/`number`; string yang bukan angka → `validation_failed` | `{"eruption_count_24h": {"from":"string","to":"integer"}}` |
| `required` | daftar field wajib; harus memuat `report_id, volcano_id, alert_level, reported_at` | tanpa `eruption_count_24h` |
| `label` | nama versi untuk log/metrik | `m2-adjusted` |

Tabel koersi `alert_level` divalidasi saat load: nilainya wajib salah satu enum. Kalau file tidak valid, file ditolak dan mapping lama tetap aktif.

Setelah config berubah, pesan terparkir diproses ulang lewat `POST /internal-ops/dlq/replay` (role `internal`, § replay D-37). Byte asli di DLQ dibaca ulang dengan mapping yang aktif saat itu.

**Butuh perubahan kode**:
- `report_id` hilang;
- gunung baru (tabel referensi);
- format tanggal baru;
- envelope baru;
- field kanonik baru yang harus masuk ke kolom HazardEvent (bukan `attributes`);
- koersi yang tidak berupa tabel atau konversi angka (misalnya satuan, rumus).

## 4. Alasan kebijakan
- **Aditif diterima (tolerant reader, Postel)**: field baru tidak mengubah makna field lama. Ini konsisten dengan M1, yang sudah menerima `confidence_level` v2 tanpa perubahan. Menolak aditif akan membuat setiap evolusi sumber menjadi gangguan.
- **Rename dan perubahan tipe tidak ditebak otomatis**: tebakan bisa salah makna secara diam-diam. Contoh: `level` yang ternyata skala 1–4 dan bukan 0–3; angka `2` yang berarti "Waspada" di versi lain. Dengan tabel eksplisit di config, ada manusia yang menyatakan maknanya, dan pernyataan itu ter-versi (hash/label di setiap replica).
- **Disimpan, bukan dibuang**: hint spek. Byte asli disimpan utuh (Tahap 1, `unprocessed_messages` + GridFS) beserta alasan, sumber, dan waktu, sehingga setelah sistem disesuaikan pesan dapat diproses ulang dari sumber kebenaran yang sama (P3 #2, #4). Membuang pesan berarti kehilangan laporan gunung api.
- **`window_skipped` dan penahanan checkpoint**: body yang rusak seluruhnya tidak bisa dipulihkan dari byte-nya (record setelah titik potong tidak ada di byte itu), sehingga satu-satunya sumber pemulihan adalah poll ulang. Batas K mencegah satu body beracun memblokir sumber selamanya (D-34). Jendela yang dilewati tidak dianggap sukses dan tidak ditinggalkan: retry worker memoll ulang jendela itu sampai body valid diterima (D-44).

## 5. Alternatif yang ditolak
| Alternatif | Kelebihan | Kenapa ditolak |
|---|---|---|
| Schema registry Avro/Protobuf (Confluent, kompatibilitas BACKWARD/FORWARD) | Kompatibilitas dicek sebelum produsen menulis; evolusi formal | PVMBG adalah sumber eksternal ber-JSON lewat HTTP yang tidak kita kendalikan, sehingga registry tidak bisa memaksa produsen. Menambah komponen dan bahasa skema baru tanpa mengurangi kasus rename/tipe yang tetap butuh pemetaan |
| Tolak semua perubahan, termasuk aditif | Paling ketat, tidak ada kejutan | Bertentangan dengan M1 (v2 aditif harus diterima); setiap field baru menghentikan ingest |
| Tebak rename otomatis (kemiripan nama/tipe) | Pulih tanpa campur tangan | Salah makna diam-diam. Validator hanya memberi **petunjuk** di reason ("kemungkinan di-rename menjadi 'level'"), tetapi tetap memarkir pesan |

## 6. Batasan yang disadari
- Petunjuk rename memilih field tak dikenal pertama yang tipenya cocok. Field aditif yang tidak terkait bisa muncul sebagai kandidat; petunjuk itu hanya teks.
- Koersi hanya berupa tabel nilai atau string→angka. Perubahan semantik (satuan meter→kaki) butuh kode.
- Mapping berlaku global untuk semua record yang diproses setelah reload. Record lama dan baru tidak dibedakan per versi skema sumber, karena PVMBG tidak mengirim versi di payload. Karena alias dan koersi hanya aktif bila bentuknya cocok, record v1/v2 normal tetap identik (test `mapping does not change normal v1/v2 records`).
- Antar replica ada jendela ≤ `PVMBG_MAPPING_POLL_MS` (2 s) tempat mapping bisa berbeda. Skrip demo menunggu semua replica melaporkan hash yang sama sebelum replay.
- Penahanan checkpoint (D-34) membuat status PVMBG `STALE` selama ≤ K poll, dan status tetap `STALE` setelah jendela dilewati sampai body valid diterima (D-44). Data di jendela yang dilewati pulih lewat backfill otomatis (`window_skipped`, retryable). Kalau sumber tetap rusak sampai percobaan habis, entri menjadi `retry_exhausted` dan perlu replay manual. Backfill memakai `since` tanpa batas atas (kontrak mock), sehingga jendela yang sangat lama bisa menghasilkan respons besar.
- `report_id_conflict` (field report) mengikuti aturan "pertama menang". Koreksi isi oleh pelapor butuh `report_id` baru.
