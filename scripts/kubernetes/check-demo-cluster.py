#!/usr/bin/env python3
"""Validate the explicit six-node placement and node-local storage before mutations."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location('renderer', Path(__file__).with_name('render-full-stack.py'))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


def memory_bytes(value):
    suffixes = {'Ki': 1024, 'Mi': 1024**2, 'Gi': 1024**3, 'Ti': 1024**4,
                'K': 1000, 'M': 1000**2, 'G': 1000**3}
    for suffix, multiplier in suffixes.items():
        if value.endswith(suffix):
            return int(float(value[:-len(suffix)]) * multiplier)
    return int(value)


def validate(config, nodes, classes, development=False):
    renderer.validate_config(config)
    by_name = {n['metadata']['name']: n for n in nodes}
    selected = config['storageNodes']['a'] + config['storageNodes']['b']
    boot_ids = set()
    for name in selected:
        n = by_name.get(name)
        if not n:
            raise ValueError('Configured node not found: ' + name)
        if n['spec'].get('unschedulable') or any(t.get('effect') in ('NoSchedule', 'NoExecute') for t in n['spec'].get('taints', [])):
            raise ValueError('Node is not schedulable: ' + name)
        if not any(c['type'] == 'Ready' and c['status'] == 'True' for c in n['status']['conditions']):
            raise ValueError('Node is not Ready: ' + name)
        if n['metadata'].get('labels', {}).get('kubernetes.io/hostname') != name:
            raise ValueError('Node hostname label must equal configured node name: ' + name)
        # Include system headroom and a potential Aggregator on each node. VM A hosts singletons.
        required_mi = (1024 if name in config['storageNodes']['a'] else 512) + 256 + 512
        if name == config['stableNodeName']:
            required_mi += 5*512 + 512 + 128 + 2*128 + 2*128 + 2*64
        if memory_bytes(n['status']['allocatable']['memory']) < required_mi * 1024**2:
            raise ValueError('Insufficient allocatable memory on ' + name + ': need at least ' + str(required_mi) + 'Mi')
        info = n['status']['nodeInfo']
        boot_ids.add(info.get('bootID'))
        description = (name + ' ' + n['spec'].get('providerID', '') + ' ' + info.get('osImage', '')).lower()
        if not development and any(x in description for x in ('desktop-', 'kind://', 'kind-', 'kindest', 'k3d-', 'minikube')):
            raise ValueError('Container-node cluster is development-only; demo requires separate-kernel VMs')
    if not development and (None in boot_ids or '' in boot_ids or len(boot_ids) != len(selected)):
        raise ValueError('Each of the six nodes must have a distinct kernel boot ID')
    storage = next((c for c in classes if c['metadata']['name'] == config['storageClassName']), None)
    if not storage or storage.get('provisioner') != 'rancher.io/local-path' or storage.get('volumeBindingMode') != 'WaitForFirstConsumer':
        raise ValueError('Supported local storage: rancher.io/local-path with WaitForFirstConsumer. Verify backing disk and PV node affinity after deploy.')
    return selected


def main():
    config = json.load(open(sys.argv[1]))
    context = os.environ.get('KUBE_CONTEXT') or config['context']
    def get(kind):
        return json.loads(subprocess.check_output(['kubectl', '--context', context, 'get', kind, '-o', 'json', '--request-timeout=15s'], text=True))['items']
    names = validate(config, get('nodes'), get('storageclass'), os.environ.get('BNPB_DEVELOPMENT_CLUSTER') == '1')
    print('Cluster preflight passed:', ', '.join(names))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
