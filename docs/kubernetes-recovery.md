# Pengujian dan pemulihan MongoDB lokal

Gunakan [petunjuk.md](../petunjuk.md) untuk urutan lengkap, kriteria lulus, dan pencatatan bukti. Batas penerimaan ada di [audit-instructions.md](audit-instructions.md).

Data `mongod` dan PostgreSQL menggunakan local-path PVC. PV harus berisi hostPath/local dan node affinity ke node yang menjalankan Pod. Restart Pod pada node sehat mempertahankan data. Reclaim policy mengikuti StorageClass/PV (default K3s umumnya `Delete`); konfirmasikan dari objek aktual. Menghapus PVC dengan reclaim `Delete` dapat menghapus direktori backing disk. Dengan `Retain`, PV lama menjadi `Released` dan harus ditangani terpisah setelah status replika diperiksa.

Kehilangan satu anggota MongoDB menyisakan dua salinan/quorum. Pemilihan primary serta initial sync pada anggota kosong ditangani MongoDB. Hal tersebut belum menyediakan otomatisasi penggantian node Kubernetes, PVC yang terikat pada node hilang, dan seluruh singleton dependency.

## Recovery satu volume yang sudah dikonfirmasi hilang

`replace-member.sh NAMESPACE REPLICA_SET --lost-volume` hanya menangani ordinal 2. Script memeriksa dua anggota sehat, mengurangi replika menjadi dua, menghapus PVC ordinal 2, menambah replika menjadi tiga, lalu menunggu anggota baru sehat. Jalankan hanya pada cluster uji yang datanya boleh diganti dari replika lain. Sebelum menjalankan, rekam target Pod/PVC/PV/node dan pastikan kedua survivor benar-benar menyimpan write yang diakui.

```bash
export KUBECONFIG=/path/to/demo-only.kubeconfig
export KUBE_CONTEXT=bnpb-demo
export NS=sistem-informasi-kebencanaan-bnpb
bash scripts/kubernetes/verify-mongo.sh "$NS"
bash scripts/kubernetes/replace-member.sh "$NS" canonical-shard-b --lost-volume
bash scripts/kubernetes/verify-mongo.sh "$NS"
```

Operasi ini merupakan repair manual, bukan kelulusan recovery otomatis game day. Disk yang benar-benar hilang saat node mati, ordinal 0/1, dan node baru harus diuji tersendiri. Jangan menghapus PVC survivor.

## Node hilang permanen

1. Konfirmasikan node lama benar-benar mati dan tidak akan kembali dengan data lama.
2. Rekam replica status melalui anggota sehat, acknowledgement write, count/checksum baseline, Pod mapping, PVC/PV affinity dan reclaim policy.
3. Sediakan dan join node baru dengan kernel terpisah, disk kosong dan kapasitas cukup. Ini tindakan provisioning eksternal.
4. Perbarui `storageNodes` agar node baru menggantikan node lama dalam kelompok shard yang sama. Jangan pernah memasukkan node ke kedua kelompok.
5. Recovery controller untuk memindahkan semua ordinal/claim otomatis **belum tersedia**. Jangan memakai `kubectl drain` sebagai bukti pemindahan disk: local PV lama tetap terikat pada node lama. Untuk ordinal 2 yang sudah dipastikan hilang, prosedur penggantian volume di atas dapat digunakan setelah affinity workload diperbarui lewat redeploy.
6. Tunggu initial sync; bandingkan count/checksum dataset beku, jalankan `verify-distribution.py`, dan pastikan write baru muncul pada node baru. Ulangi gangguan worker lain hanya setelah semua replika sehat kembali.

`replace-node.sh --drain` adalah helper eviksi sukarela yang tunduk PDB. Ia bukan pemulihan node/disk permanen dan bisa menunggu timeout dengan local PV. `run-disk-loss-drill.sh` menggabungkan helper ordinal 2, baseline checksum, dan k6; jalur tersebut tidak menggantikan Tester Agent atau membuktikan S04–S06 otomatis.
