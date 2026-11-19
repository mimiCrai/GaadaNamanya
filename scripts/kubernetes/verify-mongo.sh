#!/usr/bin/env bash
set -euo pipefail
: "${KUBE_CONTEXT:?Set KUBE_CONTEXT explicitly}"
kubectl() { command kubectl --context "$KUBE_CONTEXT" "$@"; }
namespace=${1:-sistem-informasi-kebencanaan-bnpb}
kubectl -n "$namespace" exec deploy/canonical-store -- mongosh --quiet --eval '
  const admin = db.getSiblingDB("admin");
  admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
  const shards = admin.runCommand({ listShards: 1 }).shards;
  if (shards.length !== 2) throw new Error("Expected two shards");
  const config = db.getSiblingDB("config");
  const collection = config.collections.findOne({ _id: (process.env.CANONICAL_STORE_DB_NAME || "canonical_store") + ".hazard_events" });
  if (!collection) throw new Error("hazard_events is not sharded");
  const chunks = config.chunks.aggregate([
    { $match: { uuid: collection.uuid } },
    { $group: { _id: "$shard", count: { $sum: 1 } } },
  ]).toArray();
  if (chunks.length !== 2 || chunks.some(c => c.count < 1)) throw new Error("Chunks are not distributed across both shards");
  printjson({ shards: shards.map(s => s._id), chunks });
'
for set in canonical-config canonical-shard-a canonical-shard-b; do
  kubectl -n "$namespace" exec "$set-0" -- mongosh --quiet --eval '
    const admin = db.getSiblingDB("admin");
    admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD);
    const members = admin.runCommand({ replSetGetStatus: 1 }).members;
    if (members.filter(m => m.health === 1 && [1, 2].includes(m.state)).length !== 3) throw new Error("Replica set not fully healthy");
    printjson(members.map(m => ({ name: m.name, state: m.stateStr, health: m.health })));
  '
done
