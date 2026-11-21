# Pengujian dan pemulihan MongoDB lokal

Gunakan [petunjuk.md](../petunjuk.md) untuk urutan lengkap, kriteria lulus, dan pencatatan bukti. Batas penerimaan ada di [audit-instructions.md](audit-instructions.md).

Data `mongod` dan PostgreSQL menggunakan local-path PVC. PV harus berisi hostPath/local dan node affinity ke node yang menjalankan Pod. Restart Pod pada node sehat mempertahankan data. Reclaim policy mengikuti StorageClass/PV (default K3s umumnya `Delete`); konfirmasikan dari objek aktual. Menghapus PVC dengan reclaim `Delete` dapat menghapus direktori backing disk. Dengan `Retain`, PV lama menjadi `Released` dan harus ditangani terpisah setelah status replika diperiksa.

Kehilangan satu anggota MongoDB menyisakan dua salinan/quorum. Pemilihan primary serta initial sync pada anggota kosong ditangani MongoDB. Hal tersebut belum menyediakan otomatisasi penggantian node Kubernetes, PVC yang terikat pada node hilang, dan seluruh singleton dependency.

## Recovery satu volume yang sudah dikonfirmasi hilang

`replace-member.sh NAMESPACE REPLICA_SET ORDINAL --lost-volume` menerima ordinal **0, 1, atau 2** secara eksplisit. Script memeriksa dua survivor sehat (termasuk primary), menyimpan manifest pemulihan, melepas StatefulSet dengan `--cascade=orphan`, lalu menghapus **hanya Pod dan PVC target**. Kedua survivor tetap berjalan; tidak ada scale-down yang ikut mematikan ordinal 2. StatefulSet dibuat kembali dengan tiga replika dan strategi `OnDelete` agar adopsi/ubah affinity tidak merestart survivor. Retensi PVC disetel `Retain` sebelum controller dilepas.

Script menunggu Pod baru, memastikan PV berbeda dari PV lama, dan memeriksa status MongoDB melalui survivor sampai ketiga anggota PRIMARY/SECONDARY sehat. Readiness `ping` saja tidak dianggap sebagai selesainya initial sync. Jalankan hanya pada cluster uji yang volumenya sudah dipastikan hilang. Sebelum menjalankan, rekam target Pod/PVC/PV/node dan pastikan kedua survivor benar-benar menyimpan write yang diakui.

Jika Pod target sudah dihapus atau penggantinya masih `Pending` tanpa `spec.nodeName`, helper membaca PVC `data-REPLICA_SET-ORDINAL` yang masih terikat, lalu mengambil hostname sumber dari node affinity PV tersebut. Hostname harus menunjuk tepat satu objek Node; affinity yang kosong/ambigu ditolak sebelum perubahan apa pun. Pemeriksaan fencing dan dua survivor tetap berlaku pada jalur ini.

```bash
export KUBECONFIG=/path/to/demo-only.kubeconfig
export KUBE_CONTEXT=bnpb-demo
export NS=sistem-informasi-kebencanaan-bnpb
bash scripts/kubernetes/verify-mongo.sh "$NS"
# Contoh: disk anggota ordinal 1 hilang, node tetap sehat.
bash scripts/kubernetes/replace-member.sh "$NS" canonical-shard-b 1 --lost-volume
bash scripts/kubernetes/verify-mongo.sh "$NS"
```

Operasi ini merupakan repair manual, bukan kelulusan recovery otomatis game day. Jangan menghapus PVC survivor atau memulai penggantian kedua sebelum seluruh replika sehat kembali. Jika script gagal, manifest di `/tmp/bnpb-member-recovery-*/statefulset.json` tetap tersedia dan path dicetak. Jika controller sudah dilepas, script mencoba membuatnya kembali sebelum keluar. Setelah interupsi keras, periksa keberadaan StatefulSet dan gunakan manifest tersebut dengan `kubectl --context "$KUBE_CONTEXT" -n "$NS" create -f PATH` hanya jika StatefulSet belum ada. Jangan melakukan redeploy bersamaan dengan repair.

## Node hilang permanen

1. Fence node lama melalui hypervisor/power control: proses lama harus benar-benar berhenti dan tidak boleh kembali dengan data lama. Status Kubernetes `NotReady` saja bukan bukti fencing. Pertahankan objek Node lama sampai pemetaan recovery selesai.
2. Rekam replica status melalui anggota sehat, acknowledgement write, count/checksum baseline, Pod mapping, PVC/PV affinity dan reclaim policy.
3. Sediakan dan join node baru dengan kernel terpisah, disk kosong dan kapasitas cukup. Ini tindakan provisioning eksternal.
4. Identifikasi **seluruh** Pod `canonical-config`, `canonical-shard-a`, atau `canonical-shard-b` pada node hilang dengan `kubectl --context "$KUBE_CONTEXT" -n "$NS" get pods -o wide`. Untuk setiap replica set, catat ordinal yang benar. Setiap set harus masih memiliki dua survivor sehat.
5. Jalankan helper di bawah untuk setiap anggota yang hilang, satu per satu. `--replacement-node` memeriksa node Ready/schedulable, menolak node kelompok shard lawan atau node yang sudah menampung survivor, lalu mengganti hostname lama pada affinity set target. `--node-fenced` adalah konfirmasi operator atas langkah 1 dan mengizinkan force-delete **hanya Pod target** pada node mati; tidak menghapus finalizer PVC/PV. Script memverifikasi Pod baru benar-benar berjalan di node pengganti. Local PV lama tidak dipindah: PVC baru mendapat disk kosong lalu MongoDB melakukan initial sync.
6. Tunggu initial sync; bandingkan count/checksum dataset beku, jalankan `verify-distribution.py`, dan pastikan write baru muncul pada node baru. Ulangi gangguan worker lain hanya setelah semua replika sehat kembali.

```bash
# Contoh: canonical-shard-b-0 hilang bersama node lamanya yang sudah di-fence.
bash scripts/kubernetes/replace-member.sh "$NS" canonical-shard-b 0 \
  --lost-volume --replacement-node bnpb-f-new --node-fenced
bash scripts/kubernetes/verify-mongo.sh "$NS"
```

Setelah seluruh anggota pada node lama pulih, perbarui `storageNodes` di `k8s/full-stack.json` agar node baru menggantikan hostname lama dalam kelompok yang sama. Node tidak boleh masuk kedua kelompok. Helper hanya mengubah affinity StatefulSet target yang sedang dipulihkan; konfigurasi deployment tetap harus diselaraskan. Strategi set tersebut tetap `OnDelete`; untuk kembali ke `RollingUpdate`, sesudah seluruh replica set sehat, jalankan `kubectl --context "$KUBE_CONTEXT" -n "$NS" patch statefulset REPLICA_SET --type=merge -p '{"spec":{"updateStrategy":{"type":"RollingUpdate"}}}'` dan pantau rollout sebelum gangguan berikutnya. Perubahan affinity dapat memicu rolling restart survivor pada tahap ini.

Jika penghapusan local PVC/PV macet karena node/provisioner hilang, script berhenti dengan timeout dan mengembalikan controller; selesaikan penanganan reclaim/provisioner sesuai status aktual. Jangan menghapus finalizer secara membabi buta. Provisioning node, fencing, dan pemulihan singleton di control plane tetap tindakan eksternal, bukan recovery otomatis.

`replace-node.sh --drain` adalah helper eviksi sukarela yang tunduk PDB. Ia bukan pemulihan node/disk permanen dan bisa menunggu timeout dengan local PV. `run-disk-loss-drill.sh NAMESPACE REPLICA_SET ORDINAL BASELINE_JSON [--replacement-node NODE] [--node-fenced]` menggabungkan helper anggota terpilih, baseline checksum, dan k6; jalur tersebut tidak menggantikan Tester Agent atau membuktikan S04–S06 otomatis.

Regresi offline: `python3 scripts/kubernetes/test-recovery.py` menguji setiap ordinal, pemilihan node, quorum, dan pemulihan controller saat error. Bukti initial sync fisik, checksum/write baru di node pengganti, dan dua gangguan worker berurutan tetap harus direkam di cluster enam node sesuai langkah 6.

Referensi: [StatefulSet orphan deletion](https://kubernetes.io/docs/tasks/run-application/delete-stateful-set/) dan [MongoDB initial sync satu anggota](https://www.mongodb.com/docs/v7.0/tutorial/resync-replica-set-member/).
