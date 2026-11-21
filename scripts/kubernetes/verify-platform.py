#!/usr/bin/env python3
"""Check running Pod roles/resources, baseline placement and local volume affinity."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('renderer', Path(__file__).with_name('render-full-stack.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
NS = 'sistem-informasi-kebencanaan-bnpb'


def get(kind, namespace=True):
    args = ['kubectl', '--context', os.environ['KUBE_CONTEXT']] + (['-n', NS] if namespace else [])
    return json.loads(subprocess.check_output(args + ['get', kind, '-o', 'json', '--request-timeout=15s'], text=True))['items']


def main():
    if len(sys.argv) > 1 and sys.argv[1] != NS:
        raise ValueError('Application namespace must be ' + NS)
    pods, claims, volumes = get('pods'), get('pvc'), get('pv', False)
    claims = {c['metadata']['name']: c for c in claims}
    volumes = {v['metadata']['name']: v for v in volumes}
    groups = {'canonical-shard-a': set(), 'canonical-shard-b': set()}
    aggregators = set()
    checked = 0
    for pod in pods:
        labels = pod['metadata'].get('labels', {})
        role, app = labels.get('role'), labels.get('app', '')
        if pod['status'].get('phase') in ('Failed', 'Succeeded'):
            continue
        expected = {'aggregator': ('256Mi', '512Mi'), 'store': ('512Mi', '1Gi'),
                    'broker': ('512Mi', '1Gi'), 'consumer': ('128Mi', '256Mi'),
                    'api': ('128Mi', '256Mi'), 'mock': ('64Mi', '128Mi'),
                    'sensor': ('128Mi', '256Mi'), 'other': ('128Mi', '256Mi')}
        if role not in expected:
            raise ValueError('Missing/invalid role: ' + pod['metadata']['name'])
        for container in pod['spec']['containers']:
            resources = container.get('resources', {})
            actual = tuple(resources.get(k, {}).get('memory') for k in ('requests', 'limits'))
            if actual != expected[role]:
                raise ValueError('Memory mismatch: ' + pod['metadata']['name'] + '/' + container['name'])
        if len(pod['spec']['containers']) != 1:
            raise ValueError('Multiple containers need an explicit per-Pod budget review: ' + pod['metadata']['name'])
        node = pod['spec'].get('nodeName')
        if app == 'bnpb-aggregator': aggregators.add(node)
        if app in groups: groups[app].add(node)
        if role == 'store':
            for mount in pod['spec'].get('volumes', []):
                if 'persistentVolumeClaim' not in mount: continue
                claim = claims[mount['persistentVolumeClaim']['claimName']]
                if claim['status']['phase'] != 'Bound': raise ValueError('PVC not Bound')
                pv = volumes[claim['spec']['volumeName']]
                if not any(k in pv['spec'] for k in ('hostPath', 'local')):
                    raise ValueError('Store is not backed by node-local disk: ' + pv['metadata']['name'])
                terms = pv['spec'].get('nodeAffinity', {}).get('required', {}).get('nodeSelectorTerms', [])
                if not any(any(e['key'] == 'kubernetes.io/hostname' and e['operator'] == 'In' and node in e['values'] for e in t.get('matchExpressions', [])) for t in terms):
                    raise ValueError('PV affinity does not pin storage to its Pod node: ' + pv['metadata']['name'])
        checked += 1
    if None in aggregators or len(aggregators) < 3:
        raise ValueError('Baseline requires Aggregators on at least three distinct nodes')
    if any(None in group or len(group) != 3 for group in groups.values()) or groups['canonical-shard-a'] & groups['canonical-shard-b']:
        raise ValueError('Data shard groups must each use three distinct, disjoint nodes')
    print(json.dumps({'checked_pods': checked, 'aggregator_nodes': sorted(aggregators),
                      'shard_nodes': {k: sorted(v) for k, v in groups.items()}}, indent=2))


if __name__ == '__main__':
    try: main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
