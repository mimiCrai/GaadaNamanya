#!/usr/bin/env python3
"""Offline deployment regression tests. Requires Docker Compose CLI and PyYAML, no cluster."""
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import yaml

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


r = module('renderer', ROOT / 'scripts/kubernetes/render-full-stack.py')
c = module('cluster', ROOT / 'scripts/kubernetes/check-demo-cluster.py')


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads((ROOT / 'k8s/full-stack.json.example').read_text())

    def test_namespace_is_fixed(self):
        self.config['namespace'] = 'bnpb'
        with self.assertRaisesRegex(ValueError, 'namespace'): r.validate_config(self.config)

    def test_storage_groups_cannot_overlap(self):
        self.config['storageNodes']['b'][0] = 'bnpb-a'
        with self.assertRaisesRegex(ValueError, 'disjoint'): r.validate_config(self.config)

    def test_context_required(self):
        del self.config['context']
        with self.assertRaisesRegex(ValueError, 'context'): r.validate_config(self.config)

    def test_memory_contract_is_enforced(self):
        self.config['resources']['bnpb-aggregator']['requests']['memory'] = '128Mi'
        with self.assertRaisesRegex(ValueError, 'Appendix B'): r.resource(self.config, 'bnpb-aggregator')

    def nodes(self):
        return [{'metadata': {'name': name, 'labels': {'kubernetes.io/hostname': name}}, 'spec': {},
                 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}], 'allocatable': {'memory': '8Gi'},
                            'nodeInfo': {'bootID': name, 'osImage': 'Linux'}}}
                for name in self.config['storageNodes']['a'] + self.config['storageNodes']['b']]

    def classes(self):
        return [{'metadata': {'name': 'local-path'}, 'provisioner': 'rancher.io/local-path', 'volumeBindingMode': 'WaitForFirstConsumer'}]

    def test_demo_rejects_shared_kernel(self):
        nodes = self.nodes()
        for n in nodes: n['status']['nodeInfo']['bootID'] = 'shared'
        with self.assertRaisesRegex(ValueError, 'distinct kernel'): c.validate(self.config, nodes, self.classes())

    def test_demo_rejects_cordoned_node(self):
        nodes = self.nodes(); nodes[0]['spec']['unschedulable'] = True
        with self.assertRaisesRegex(ValueError, 'schedulable'): c.validate(self.config, nodes, self.classes())

    def test_demo_rejects_nonlocal_storage(self):
        classes = self.classes(); classes[0]['provisioner'] = 'remote-disk'
        with self.assertRaisesRegex(ValueError, 'local storage'): c.validate(self.config, self.nodes(), classes)

    def test_demo_accepts_six_kernel_topology(self):
        self.assertEqual(len(c.validate(self.config, self.nodes(), self.classes())), 6)

    def test_full_render_and_redeploy_are_deterministic(self):
        init = module('secrets', ROOT / 'scripts/kubernetes/init-secrets.py')
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            init.TARGET = temp / 'secret.env'
            init.main()
            self.config['imageRepository'] = 'docker.io/test/bnpb'
            self.config['imageTag'] = 'test-001'
            self.config['imagePullSecret'] = 'registry-access'
            config = temp / 'config.json'; config.write_text(json.dumps(self.config))
            def manifests(filename):
                return list(yaml.safe_load_all((ROOT / 'k8s' / filename).read_text()))
            with patch.object(r, 'kubectl_objects', manifests), patch.object(sys, 'argv', ['render', str(config), str(init.TARGET), str(temp / 'out')]):
                r.main()
                first = {p.name: p.read_text() for p in (temp / 'out').glob('*.json')}
                r.main()
                self.assertEqual(first, {p.name: p.read_text() for p in (temp / 'out').glob('*.json')})
            objects = [x for text in first.values() for x in json.loads(text)['items']]
            workloads = [x for x in objects if x['kind'] in ('Deployment', 'StatefulSet', 'Job')]
            for obj in workloads:
                pod = obj['spec']['template']
                self.assertIn(pod['metadata']['labels']['role'], ('aggregator','store','other','api','consumer','broker','sensor','mock'))
                self.assertEqual(pod['spec']['imagePullSecrets'], [{'name': 'registry-access'}])
            aggregator = next(x for x in workloads if x['metadata']['name'] == 'bnpb-aggregator')
            self.assertEqual(aggregator['spec']['replicas'], 3)
            self.assertEqual(aggregator['spec']['strategy']['rollingUpdate']['maxUnavailable'], 0)
            for name, nodes in [('canonical-shard-a', self.config['storageNodes']['a']), ('canonical-shard-b', self.config['storageNodes']['b'])]:
                workload = next(x for x in workloads if x['metadata']['name'] == name)
                affinity = workload['spec']['template']['spec']['affinity']['nodeAffinity']
                self.assertEqual(affinity['requiredDuringSchedulingIgnoredDuringExecution']['nodeSelectorTerms'][0]['matchExpressions'][0]['values'], nodes)
            for obj in objects:
                if obj['kind'] == 'ConfigMap':
                    self.assertFalse(any(r.is_secret(key) for key in obj.get('data', {})))
            for obj in workloads:
                if obj['kind'] == 'Job':
                    self.assertRegex(obj['metadata']['name'], r'-[a-f0-9]{10}$')
                    self.assertGreater(obj['spec']['activeDeadlineSeconds'], 0)


if __name__ == '__main__': unittest.main()
