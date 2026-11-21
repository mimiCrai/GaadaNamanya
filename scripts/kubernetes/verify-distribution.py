#!/usr/bin/env python3
"""Count unique physical HazardEvents per node, including every replica and orphan."""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

NS = 'sistem-informasi-kebencanaan-bnpb'


def main():
    args = ['kubectl', '--context', os.environ['KUBE_CONTEXT'], '-n', NS]
    pods = json.loads(subprocess.check_output(args + ['get', 'pods', '-l', 'role=store', '-o', 'json'], text=True))['items']
    by_node, by_pod = {}, {}
    code = '''db.getSiblingDB("admin").auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD);
    db.getMongo().setReadPref("secondaryPreferred");
    const d=db.getSiblingDB(process.env.CANONICAL_STORE_DB_NAME || "canonical_store");
    print(JSON.stringify(d.hazard_events.find({}, {_id:1}).toArray().map(x=>x._id)));'''
    for pod in pods:
        if pod['metadata']['labels'].get('app') not in ('canonical-shard-a', 'canonical-shard-b'): continue
        name, node = pod['metadata']['name'], pod['spec']['nodeName']
        output = subprocess.check_output(args + ['exec', name, '--', 'mongosh', '--quiet', '--eval', code], text=True, timeout=60)
        ids = set(json.loads(output.strip().splitlines()[-1]))
        by_node.setdefault(node, set()).update(ids)
        by_pod[name] = {'node': node, 'physical_unique_count': len(ids)}
    if len(by_pod) != 6: raise ValueError('Expected all six data-bearing replicas')
    logical = set().union(*by_node.values())
    if not logical: raise ValueError('Import a nonempty catalog before checking distribution')
    result = {'as_of': datetime.now(timezone.utc).isoformat(), 'unique_count': len(logical),
              'nodes': {n: len(ids) for n, ids in by_node.items()}, 'replicas': by_pod}
    print(json.dumps(result, indent=2))
    if any(ids == logical for ids in by_node.values()):
        raise ValueError('P1.1 failed: at least one node physically stores the entire dataset')
    # Every logical event must have three physical data copies, across three nodes.
    if any(sum(identifier in ids for ids in by_node.values()) != 3 for identifier in logical):
        raise ValueError('Replication incomplete: each event must exist on three distinct nodes')


if __name__ == '__main__':
    try: main()
    except (ValueError, KeyError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
