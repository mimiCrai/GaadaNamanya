#!/usr/bin/env python3
"""Exercise recovery orchestration against a stateful fake Kubernetes API."""
import argparse
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('recovery', ROOT / 'scripts/kubernetes/replace-member.py')
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


def workload(name, hosts):
    return {'apiVersion': 'apps/v1', 'kind': 'StatefulSet',
            'metadata': {'name': name, 'uid': 'old-controller', 'resourceVersion': '17'},
            'status': {'readyReplicas': 2},
            'spec': {'replicas': 3, 'selector': {'matchLabels': {'app': name}},
                     'updateStrategy': {'type': 'RollingUpdate'},
                     'volumeClaimTemplates': [{'metadata': {'name': 'data'}, 'spec': {}, 'status': {}}],
                     'template': {'spec': {'affinity': {'nodeAffinity': {
                         'requiredDuringSchedulingIgnoredDuringExecution': {'nodeSelectorTerms': [{
                             'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': hosts}]
                         }]}}}}}}}


class Cluster:
    def __init__(self, ordinal):
        self.target = f'canonical-shard-a-{ordinal}'
        self.workloads = {name: workload(name, [f'node-{group}{n}' for n in range(3)])
                          for name, group in [('canonical-shard-a', 'a'), ('canonical-shard-b', 'b')]}
        self.nodes = {f'node-{group}{n}': {
            'metadata': {'name': f'node-{group}{n}', 'labels': {'kubernetes.io/hostname': f'node-{group}{n}'}}, 'spec': {},
            'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
            for group in ('a', 'b') for n in range(3)}
        self.nodes['replacement'] = {'metadata': {'labels': {'kubernetes.io/hostname': 'replacement'}},
                                     'spec': {}, 'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
        self.pods = {f'canonical-shard-a-{n}': {'metadata': {'uid': f'original-{n}'},
                     'spec': {'nodeName': f'node-a{n}'},
                     'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}} for n in range(3)}
        self.claim = {'spec': {'volumeName': 'lost-pv'}}
        self.volume = {'spec': {'nodeAffinity': {'required': {'nodeSelectorTerms': [{
            'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In', 'values': [f'node-a{ordinal}']}]
        }]}}}}
        self.calls = []
        self.no_quorum = False
        self.lose_quorum_after_delete = False
        self.fail_pvc_delete = False
        self.complete_checks = 0
        self.sync_never_completes = False
        self.created = None
        self.missing_pod_reads = 0

    def kubectl(self, *args):
        self.calls.append(args)
        if args[:2] == ('get', 'nodes'):
            hostname = args[args.index('--selector') + 1].split('=', 1)[1]
            return json.dumps({'items': [node for node in self.nodes.values()
                                        if node['metadata']['labels']['kubernetes.io/hostname'] == hostname]})
        if args[0] == 'get':
            kind, name = args[1:3]
            obj = {'statefulset': self.workloads, 'node': self.nodes,
                   'pod': self.pods, 'pvc': {'data-' + self.target: self.claim},
                   'pv': {'lost-pv': self.volume}}[kind].get(name)
            if kind == 'pod' and '--ignore-not-found' in args and self.missing_pod_reads:
                self.missing_pod_reads -= 1
                return ''
            if obj is None and '--ignore-not-found' in args:
                return ''
            assert obj is not None, f'Missing {kind}/{name}'
            return json.dumps(obj)
        if args[0] == 'exec':
            script = args[-1]
            if self.no_quorum or (self.lose_quorum_after_delete and self.target not in self.pods):
                raise subprocess.CalledProcessError(1, args)
            if 'healthy.length !== 3' in script:
                self.complete_checks += 1
                # A new Pod can ping before its initial sync has completed.
                if self.complete_checks == 1 or self.sync_never_completes:
                    raise subprocess.CalledProcessError(1, args)
            else:
                assert self.target + '.' in script
                assert args[1] != self.target
            return '[{"state":"PRIMARY"},{"state":"SECONDARY"}]'
        if args[0] == 'patch':
            return ''
        if args[:2] == ('delete', 'statefulset'):
            assert '--cascade=orphan' in args
            del self.workloads[args[2]]
            return ''
        if args[:2] == ('delete', 'pod'):
            assert args[2] == self.target
            if self.target not in self.pods:
                assert '--ignore-not-found=true' in args
            self.pods.pop(self.target, None)
            return ''
        if args[:2] == ('delete', 'pvc'):
            assert args[2] == 'data-' + self.target
            assert self.target not in self.pods
            if self.fail_pvc_delete:
                raise subprocess.CalledProcessError(1, args)
            self.claim = {'spec': {'volumeName': 'fresh-pv'}}
            return ''
        if args[:2] == ('create', '-f'):
            self.created = json.loads(Path(args[2]).read_text())
            self.workloads['canonical-shard-a'] = self.created
            self.pods[self.target] = {'metadata': {'uid': 'new-member'}, 'spec': {'nodeName': 'replacement'},
                                     'status': {'conditions': [{'type': 'Ready', 'status': 'True'}]}}
            return ''
        raise AssertionError(f'Unexpected operation {args}')


class RecoveryTests(unittest.TestCase):
    def recovery(self, cluster, **changes):
        args = dict(namespace='demo', replica_set='canonical-shard-a',
                    ordinal=int(cluster.target[-1]), replacement_node='replacement', node_fenced=False)
        args.update(changes)
        result = r.Recovery(argparse.Namespace(**args), 'demo-context')
        result.kubectl = cluster.kubectl
        return result

    def run_recovery(self, recovery):
        with tempfile.TemporaryDirectory() as tmp, patch.object(r.tempfile, 'mkdtemp', return_value=tmp), \
                patch.object(r.time, 'sleep'), patch('sys.stdout', new_callable=io.StringIO):
            # Successful recovery removes its backup directory itself.
            recovery.run()

    def test_replaces_each_ordinal_without_deleting_survivors(self):
        for ordinal in range(3):
            with self.subTest(ordinal=ordinal):
                cluster = Cluster(ordinal)
                cluster.missing_pod_reads = 1
                before = copy.deepcopy(cluster.pods)
                self.run_recovery(self.recovery(cluster))
                for name in before:
                    if name != cluster.target:
                        self.assertEqual(cluster.pods[name], before[name])
                self.assertEqual([c[2] for c in cluster.calls if c[:2] == ('delete', 'pvc')], ['data-' + cluster.target])
                self.assertEqual(cluster.complete_checks, 2)
                self.assertEqual(cluster.created['spec']['replicas'], 3)
                self.assertEqual(cluster.created['spec']['updateStrategy'], {'type': 'OnDelete'})
                self.assertNotIn('uid', cluster.created['metadata'])
                groups = r.Recovery.hostname_groups(cluster.created)
                self.assertIn('replacement', groups[0])
                self.assertNotIn(f'node-a{ordinal}', groups[0])
                self.assertFalse(any(c[0] == 'scale' for c in cluster.calls))

    def test_refuses_without_two_healthy_survivors(self):
        cluster = Cluster(0)
        cluster.no_quorum = True
        with self.assertRaisesRegex(ValueError, 'two healthy survivors'):
            self.run_recovery(self.recovery(cluster))
        self.assertFalse(any(c[0] in ('delete', 'patch') for c in cluster.calls))

    def test_recovers_pending_or_missing_pod_using_bound_pv(self):
        for ordinal in range(3):
            for state in ('pending', 'missing'):
                with self.subTest(ordinal=ordinal, state=state):
                    cluster = Cluster(ordinal)
                    source = f'node-a{ordinal}'
                    cluster.nodes[source]['status']['conditions'][0]['status'] = 'Unknown'
                    if state == 'pending':
                        cluster.pods[cluster.target]['spec'].pop('nodeName')
                    else:
                        del cluster.pods[cluster.target]
                    before = copy.deepcopy(cluster.pods)
                    self.run_recovery(self.recovery(cluster, node_fenced=True))
                    self.assertIn(('get', 'pv', 'lost-pv', '-o', 'json'), cluster.calls)
                    self.assertNotIn(source, r.Recovery.hostname_groups(cluster.created)[0])
                    for name, pod in before.items():
                        if name != cluster.target:
                            self.assertEqual(cluster.pods[name], pod)
                    self.assertEqual(cluster.claim['spec']['volumeName'], 'fresh-pv')
                    self.assertEqual(cluster.complete_checks, 2)

    def test_pv_fallback_retains_fencing_and_quorum_checks(self):
        for failure in ('fencing', 'quorum'):
            with self.subTest(failure=failure):
                cluster = Cluster(1)
                cluster.pods[cluster.target]['spec'].pop('nodeName')
                cluster.nodes['node-a1']['status']['conditions'][0]['status'] = 'Unknown'
                cluster.no_quorum = failure == 'quorum'
                with self.assertRaisesRegex(ValueError, 'Fence it externally|two healthy survivors'):
                    self.run_recovery(self.recovery(cluster, node_fenced=failure == 'quorum'))
                self.assertFalse(any(c[0] in ('delete', 'patch') for c in cluster.calls))

    def test_pv_hostname_can_differ_from_node_name(self):
        cluster = Cluster(1)
        cluster.pods[cluster.target]['spec'].pop('nodeName')
        node = cluster.nodes.pop('node-a1')
        node['metadata']['name'] = 'source-node-object'
        cluster.nodes['source-node-object'] = node
        _, _, source = self.recovery(cluster).prepare()
        self.assertEqual(source, 'source-node-object')

    def test_refuses_missing_or_ambiguous_pv_affinity(self):
        for affinity in ({}, {'required': {'nodeSelectorTerms': [{
                'matchExpressions': [{'key': 'kubernetes.io/hostname', 'operator': 'In',
                                      'values': ['node-a0', 'node-a1']}]}]}}):
            with self.subTest(affinity=affinity):
                cluster = Cluster(0)
                del cluster.pods[cluster.target]
                cluster.volume['spec']['nodeAffinity'] = affinity
                with self.assertRaisesRegex(ValueError, 'exactly one source hostname'):
                    self.recovery(cluster).prepare()
                self.assertFalse(any(c[0] in ('delete', 'patch') for c in cluster.calls))

    def test_refuses_unfenced_unavailable_node(self):
        cluster = Cluster(1)
        cluster.nodes['node-a1']['status']['conditions'][0]['status'] = 'Unknown'
        with self.assertRaisesRegex(ValueError, 'Fence it externally'):
            self.recovery(cluster).prepare()

    def test_fenced_node_uses_force_only_on_selected_pod(self):
        cluster = Cluster(1)
        cluster.nodes['node-a1']['status']['conditions'][0]['status'] = 'Unknown'
        self.run_recovery(self.recovery(cluster, node_fenced=True))
        deletes = [c for c in cluster.calls if c[:2] == ('delete', 'pod')]
        self.assertEqual(len(deletes), 1)
        self.assertIn('--force', deletes[0])
        self.assertEqual(deletes[0][2], cluster.target)

    def test_unavailable_source_requires_replacement_node(self):
        cluster = Cluster(2)
        cluster.nodes['node-a2']['status']['conditions'][0]['status'] = 'Unknown'
        with self.assertRaisesRegex(ValueError, 'requires --replacement-node'):
            self.recovery(cluster, node_fenced=True, replacement_node=None).prepare()

    def test_local_disk_repair_keeps_existing_affinity(self):
        cluster = Cluster(1)
        before = copy.deepcopy(r.Recovery.hostname_groups(cluster.workloads['canonical-shard-a']))
        self.run_recovery(self.recovery(cluster, replacement_node=None))
        self.assertEqual(r.Recovery.hostname_groups(cluster.created), before)
        self.assertFalse(any('--force' in c for c in cluster.calls))

    def test_refuses_opposite_shard_and_occupied_nodes(self):
        cluster = Cluster(0)
        for node, message in [('node-b0', 'opposite shard'), ('node-a1', 'overlap')]:
            with self.subTest(node=node), self.assertRaisesRegex(ValueError, message):
                self.recovery(cluster, replacement_node=node).prepare()
        cluster.nodes['replacement']['spec']['unschedulable'] = True
        with self.assertRaisesRegex(ValueError, 'Ready and schedulable'):
            self.recovery(cluster).prepare()

    def test_restores_controller_after_pvc_deletion_fails(self):
        cluster = Cluster(0)
        cluster.fail_pvc_delete = True
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_recovery(self.recovery(cluster))
        self.assertIn('canonical-shard-a', cluster.workloads)
        self.assertEqual(cluster.claim['spec']['volumeName'], 'lost-pv')

    def test_health_loss_preserves_claim_and_restores_controller(self):
        cluster = Cluster(0)
        cluster.lose_quorum_after_delete = True
        with self.assertRaisesRegex(ValueError, 'health changed'):
            self.run_recovery(self.recovery(cluster))
        self.assertIn('canonical-shard-a', cluster.workloads)
        self.assertFalse(any(c[:2] == ('delete', 'pvc') for c in cluster.calls))

    def test_checks_new_pv_and_actual_replacement_placement(self):
        for bad in ('volume', 'placement'):
            with self.subTest(bad=bad):
                cluster = Cluster(0)
                original = cluster.kubectl
                def wrong_result(*args):
                    result = original(*args)
                    if args[:2] == ('create', '-f'):
                        if bad == 'volume':
                            cluster.claim['spec']['volumeName'] = 'lost-pv'
                        else:
                            cluster.pods[cluster.target]['spec']['nodeName'] = 'unexpected'
                    return result
                recovery = self.recovery(cluster)
                recovery.kubectl = wrong_result
                with self.assertRaisesRegex(ValueError, 'lost PV|expected replacement'):
                    self.run_recovery(recovery)

    def test_ready_pod_does_not_succeed_if_initial_sync_never_completes(self):
        cluster = Cluster(0)
        cluster.sync_never_completes = True
        with tempfile.TemporaryDirectory() as tmp, patch.object(r.tempfile, 'mkdtemp', return_value=tmp), \
                patch.object(r.time, 'sleep'), patch('sys.stdout', new_callable=io.StringIO):
            with self.assertRaisesRegex(ValueError, 'Initial sync did not complete'):
                self.recovery(cluster).run()
            self.assertTrue((Path(tmp) / 'statefulset.json').is_file())
            self.assertIn('canonical-shard-a', cluster.workloads)
            self.assertEqual(cluster.complete_checks, 180)


if __name__ == '__main__':
    unittest.main()
