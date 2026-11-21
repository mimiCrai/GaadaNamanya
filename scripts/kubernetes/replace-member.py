#!/usr/bin/env python3
"""Replace one confirmed lost Mongo PVC without stopping either survivor."""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

SETS = ('canonical-config', 'canonical-shard-a', 'canonical-shard-b')


class Recovery:
    def __init__(self, args, context):
        self.args = args
        self.context = context
        self.target = f'{args.replica_set}-{args.ordinal}'
        self.survivors = [f'{args.replica_set}-{n}' for n in range(3) if n != args.ordinal]

    def kubectl(self, *args):
        return subprocess.check_output(
            ['kubectl', '--context', self.context, '--request-timeout=30s',
             '-n', self.args.namespace, *args], text=True, timeout=360)

    def get(self, kind, name):
        return json.loads(self.kubectl('get', kind, name, '-o', 'json'))

    def healthy(self, pod, complete=False):
        # Read replica state from a survivor: Pod Ready only tests mongod's ping.
        excluded = '' if complete else f'!m.name.startsWith({json.dumps(self.target + ".")}) &&'
        script = '''
const a = db.getSiblingDB('admin');
if (!a.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD).ok) quit(1);
const s = a.runCommand({replSetGetStatus: 1});
const healthy = (s.members || []).filter(m => EXCLUDED m.health === 1 && [1, 2].includes(m.state));
if (!s.ok || healthy.length !== EXPECTED || !healthy.some(m => m.state === 1)) quit(1);
printjson(healthy.map(m => ({name: m.name, state: m.stateStr, health: m.health})));
'''.replace('EXCLUDED', excluded).replace('EXPECTED', '3' if complete else '2')
        try:
            return self.kubectl('exec', pod, '--', 'mongosh', '--quiet', '--eval', script)
        except subprocess.CalledProcessError:
            return None

    @staticmethod
    def hostname_groups(workload):
        affinity = workload['spec']['template']['spec'].get('affinity', {})
        terms = affinity.get('nodeAffinity', {}).get('requiredDuringSchedulingIgnoredDuringExecution', {}).get('nodeSelectorTerms', [])
        return [expr['values'] for term in terms for expr in term.get('matchExpressions', [])
                if expr['key'] == 'kubernetes.io/hostname' and expr['operator'] == 'In']

    def prepare(self):
        workload = self.get('statefulset', self.args.replica_set)
        if workload['spec'].get('replicas') != 3:
            raise ValueError('Expected exactly three replicas; restore replica count before recovery')
        pod = self.get('pod', self.target)
        old_node = pod['spec'].get('nodeName')
        if not old_node:
            raise ValueError('Target Pod has no source node; inspect its PVC/PV before proceeding')
        node = self.get('node', old_node)
        ready = any(c['type'] == 'Ready' and c['status'] == 'True'
                    for c in node.get('status', {}).get('conditions', []))
        if not ready and not self.args.node_fenced:
            raise ValueError('Source node is unavailable. Fence it externally, then pass --node-fenced')
        if not ready and not self.args.replacement_node:
            raise ValueError('An unavailable source node requires --replacement-node')
        claim = self.get('pvc', 'data-' + self.target)
        if not claim['spec'].get('volumeName'):
            raise ValueError('Expected a bound target PVC; inspect storage before proceeding')

        # Recreate only declarative fields; never reuse API identity or status.
        clean = {'apiVersion': workload['apiVersion'], 'kind': workload['kind'],
                 'metadata': {'name': self.args.replica_set, 'namespace': self.args.namespace,
                              'labels': workload['metadata'].get('labels', {}),
                              'annotations': {k: v for k, v in workload['metadata'].get('annotations', {}).items()
                                              if k != 'kubectl.kubernetes.io/last-applied-configuration'}},
                 'spec': copy.deepcopy(workload['spec'])}
        # Adoption must not roll surviving Pods after changing node affinity.
        clean['spec']['updateStrategy'] = {'type': 'OnDelete'}
        clean['spec']['persistentVolumeClaimRetentionPolicy'] = {'whenDeleted': 'Retain', 'whenScaled': 'Retain'}
        for template in clean['spec']['volumeClaimTemplates']:
            template.pop('status', None)
            template['metadata'] = {'name': template['metadata']['name'],
                                    'labels': template['metadata'].get('labels', {}),
                                    'annotations': template['metadata'].get('annotations', {})}

        if self.args.replacement_node:
            replacement = self.get('node', self.args.replacement_node)
            if replacement['spec'].get('unschedulable') or not any(
                    c['type'] == 'Ready' and c['status'] == 'True'
                    for c in replacement.get('status', {}).get('conditions', [])):
                raise ValueError('Replacement node must be Ready and schedulable')
            old_host = node['metadata']['labels']['kubernetes.io/hostname']
            new_host = replacement['metadata']['labels']['kubernetes.io/hostname']
            opposite = 'canonical-shard-a' if self.args.replica_set == 'canonical-shard-b' else 'canonical-shard-b'
            opposite_groups = self.hostname_groups(self.get('statefulset', opposite))
            if not opposite_groups:
                raise ValueError('Cannot verify opposite shard placement: expected explicit hostname affinity')
            if any(new_host in group for group in opposite_groups):
                raise ValueError('Replacement node belongs to the opposite shard group')
            groups = self.hostname_groups(clean)
            if not groups or not any(old_host in group for group in groups):
                raise ValueError('Expected explicit hostname affinity containing the source node')
            for group in groups:
                if old_host in group:
                    group[group.index(old_host)] = new_host
                if len(set(group)) != 3:
                    raise ValueError('Replacement would overlap an existing member placement')
            for survivor in self.survivors:
                if self.get('pod', survivor)['spec'].get('nodeName') == self.args.replacement_node:
                    raise ValueError('Replacement node already hosts a survivor')
        return clean, claim['spec']['volumeName'], old_node

    def run(self):
        workload, old_volume, old_node = self.prepare()
        survivor = next((pod for pod in self.survivors if self.healthy(pod)), None)
        if not survivor:
            raise ValueError('Refusing replacement: need two healthy survivors including a primary')

        # Retain the exact restore manifest on failure, including an interrupted run.
        backup = Path(tempfile.mkdtemp(prefix='bnpb-member-recovery-')) / 'statefulset.json'
        backup.write_text(json.dumps(workload, indent=2) + '\n')
        backup.chmod(0o600)
        print(f'Target {self.target}, PVC data-{self.target}, PV {old_volume}, source node {old_node}', flush=True)
        print(f'Recovery manifest: {backup}', flush=True)

        # Ensure a non-default retention policy cannot garbage-collect survivor claims.
        self.kubectl('patch', 'statefulset', self.args.replica_set, '--type=merge', '-p', json.dumps({
            'spec': {'persistentVolumeClaimRetentionPolicy': {'whenDeleted': 'Retain', 'whenScaled': 'Retain'}}}))
        orphaned = False
        try:
            # Scaling down would delete ordinal 2 even when 0 or 1 is the lost disk.
            self.kubectl('delete', 'statefulset', self.args.replica_set, '--cascade=orphan', '--wait=true', '--timeout=5m')
            orphaned = True
            delete = ['delete', 'pod', self.target, '--wait=true', '--timeout=5m']
            if self.args.node_fenced:
                delete += ['--force', '--grace-period=0']
            self.kubectl(*delete)
            # Recheck quorum immediately before discarding the selected claim.
            if not self.healthy(survivor):
                raise ValueError('Survivor health changed; target PVC was not deleted')
            self.kubectl('delete', 'pvc', 'data-' + self.target, '--wait=true', '--timeout=5m')
            self.kubectl('create', '-f', str(backup))
            orphaned = False
        finally:
            if orphaned:
                print(f'Restoring StatefulSet from {backup}', flush=True)
                self.kubectl('create', '-f', str(backup))

        # The StatefulSet controller creates Pods asynchronously; wait also for existence.
        for _ in range(180):
            raw = self.kubectl('get', 'pod', self.target, '--ignore-not-found', '-o', 'json')
            pod = json.loads(raw) if raw.strip() else {}
            if any(c['type'] == 'Ready' and c['status'] == 'True'
                   for c in pod.get('status', {}).get('conditions', [])):
                break
            time.sleep(5)
        else:
            raise ValueError('Replacement Pod did not become Ready within 15 minutes')
        new_claim = self.get('pvc', 'data-' + self.target)
        if not new_claim['spec'].get('volumeName') or new_claim['spec']['volumeName'] == old_volume:
            raise ValueError('Target reused the lost PV; inspect the storage provisioner')
        if self.args.replacement_node:
            actual_node = self.get('pod', self.target)['spec'].get('nodeName')
            if actual_node != self.args.replacement_node:
                raise ValueError(f'Target scheduled on {actual_node}, expected {self.args.replacement_node}')
        for _ in range(180):
            status = self.healthy(survivor, complete=True)
            if status:
                print(status)
                print(f'{self.target} initial sync complete; all three members healthy. '
                      'StatefulSet uses OnDelete to preserve survivors; update your deployment config before redeploying.')
                backup.unlink()
                backup.parent.rmdir()
                return
            time.sleep(5)
        raise ValueError('Initial sync did not complete within 15 minutes; do not replace another member')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('namespace')
    parser.add_argument('replica_set', choices=SETS)
    parser.add_argument('ordinal', type=int, choices=range(3))
    parser.add_argument('--lost-volume', required=True, action='store_true', help='Confirm target volume is lost')
    parser.add_argument('--replacement-node', help='Ready node in the same shard group, replacing the source hostname')
    parser.add_argument('--node-fenced', action='store_true', help='Confirm source node/process cannot run again; allows forced Pod deletion')
    args = parser.parse_args()
    context = os.environ.get('KUBE_CONTEXT')
    if not context:
        parser.error('Set KUBE_CONTEXT explicitly')
    try:
        Recovery(args, context).run()
    except (ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error)) from error


if __name__ == '__main__':
    main()
