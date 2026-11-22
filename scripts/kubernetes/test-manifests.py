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

    def test_kafka_probe_allows_time_for_cli_startup(self):
        workload = r.stateful('kafka', 'confluentinc/cp-kafka:7.7.1', [], {},
                              29092, '/var/lib/kafka/data', '10Gi', 'local-path')
        probe = workload['spec']['template']['spec']['containers'][0]['readinessProbe']
        self.assertGreaterEqual(probe['timeoutSeconds'], 4)
        self.assertLessEqual(probe['timeoutSeconds'], probe['periodSeconds'])

    def test_mongo_router_connections_use_client_affinity(self):
        objects = list(yaml.safe_load_all((ROOT / 'k8s/mongo.yaml').read_text()))
        router = next(x for x in objects if x['kind'] == 'Service' and x['metadata']['name'] == 'canonical-store')
        self.assertEqual(router['spec']['sessionAffinity'], 'ClientIP')
        self.assertEqual(router['spec']['sessionAffinityConfig']['clientIP']['timeoutSeconds'], 10800)

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
            router = next(x for x in objects if x['kind'] == 'Service' and x['metadata']['name'] == 'canonical-store')
            self.assertEqual(router['spec']['sessionAffinity'], 'ClientIP')
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
            self.assert_orang_c(objects, workloads)
            self.assert_observability(objects, workloads)

    def render(self, config):
        init = module('secrets', ROOT / 'scripts/kubernetes/init-secrets.py')
        with tempfile.TemporaryDirectory() as temp:
            temp = Path(temp)
            init.TARGET = temp / 'secret.env'
            init.main()
            config.update({'imageRepository': 'docker.io/test/bnpb', 'imageTag': 'test-001'})
            path = temp / 'config.json'; path.write_text(json.dumps(config))
            manifests = lambda filename: list(yaml.safe_load_all((ROOT / 'k8s' / filename).read_text()))
            with patch.object(r, 'kubectl_objects', manifests), patch.object(sys, 'argv', ['render', str(path), str(init.TARGET), str(temp / 'out')]):
                r.main()
            return {p.name: json.loads(p.read_text())['items'] for p in (temp / 'out').glob('*.json')}

    def assert_observability(self, objects, workloads):
        def find(kind, name):
            return next(x for x in objects if x['kind'] == kind and x['metadata']['name'] == name)
        compose = yaml.safe_load((ROOT / 'docker-compose.observability.yml').read_text())['services']
        for name, image in (('prometheus', r.PROMETHEUS_IMAGE), ('grafana', r.GRAFANA_IMAGE)):
            self.assertEqual(compose[name]['image'], image)
            template = find('Deployment', name)['spec']['template']
            self.assertEqual(template['metadata']['labels']['role'], 'other')
            self.assertEqual(len(template['spec']['containers']), 1)
            container = template['spec']['containers'][0]
            self.assertEqual(container['image'], image)
            # verify-platform.py class "other"
            self.assertEqual((container['resources']['requests']['memory'], container['resources']['limits']['memory']), ('128Mi', '256Mi'))
            self.assertEqual(find('Deployment', name)['spec']['strategy'], {'type': 'Recreate'})
        self.assertNotIn('type', find('Service', 'prometheus')['spec'])
        self.assertEqual(find('Service', 'grafana')['spec']['ports'][0]['nodePort'], 30006)
        headless = find('Service', 'bnpb-aggregator-pods')['spec']
        self.assertEqual((headless['clusterIP'], headless['selector']), ('None', {'app': 'bnpb-aggregator'}))
        scrape = yaml.safe_load(find('ConfigMap', 'prometheus-scrape')['data']['prometheus.yml'])
        jobs = {job['job_name']: job for job in scrape['scrape_configs']}
        self.assertEqual(jobs['bnpb-aggregator']['dns_sd_configs'][0]['names'], ['bnpb-aggregator-pods'])
        targets = [t.split(':') for t in jobs['applications']['static_configs'][0]['targets']]
        self.assertIn(['fire-processor', '3000'], targets)
        policies = {x['metadata']['name']: x['spec'] for x in objects if x['kind'] == 'NetworkPolicy'}
        # every scrape target admits Prometheus and Prometheus may reach it
        for app, port in [('bnpb-aggregator', '3000')] + targets:
            port = int(port)
            self.assertTrue(any(('from' not in rule or {'podSelector': {'matchLabels': {'app': 'prometheus'}}} in rule['from'])
                                and ('ports' not in rule or {'protocol': 'TCP', 'port': port} in rule['ports'])
                                for rule in policies[app]['ingress']), app)
            self.assertTrue(any({'podSelector': {'matchLabels': {'app': app}}} in rule['to'] and {'protocol': 'TCP', 'port': port} in rule['ports']
                                for rule in policies['prometheus']['egress']), app)
        self.assertIn({'podSelector': {'matchLabels': {'app': 'grafana'}}}, policies['prometheus']['ingress'][0]['from'])
        dashboard = (ROOT / 'scripts/observability/grafana/dashboards/bnpb.json').read_text()
        self.assertEqual(find('ConfigMap', 'grafana-dashboards')['data']['bnpb.json'], dashboard)
        datasource = yaml.safe_load(find('ConfigMap', 'grafana-provisioning')['data']['datasources.yml'])['datasources'][0]
        self.assertIn('"uid": "' + datasource['uid'] + '"', dashboard)
        self.assertEqual(datasource['url'], 'http://prometheus:9090')
        self.assertEqual(len(find('Secret', 'grafana-secret')['stringData']['GF_SECURITY_ADMIN_PASSWORD']), 32)

    def test_observability_can_be_disabled(self):
        self.config['observability'] = False
        rendered = self.render(self.config)
        self.assertEqual(rendered['observability.json'], [])
        names = {x['metadata']['name'] for items in rendered.values() for x in items}
        self.assertFalse(names & {'prometheus', 'grafana', 'prometheus-scrape', 'grafana-secret', 'bnpb-aggregator-pods'})
        bmkg = next(x for x in rendered['policies.json'] if x['metadata']['name'] == 'bmkg')
        self.assertEqual(bmkg['spec']['ingress'], r.peers(['bnpb-aggregator'], 8081))

    def test_observability_config_is_validated(self):
        self.config['observability'] = 'yes'
        with self.assertRaisesRegex(ValueError, 'observability'): r.observability_enabled(self.config)
        for port in (30003, 29999, '30006'):
            self.config['grafanaNodePort'] = port
            with self.assertRaisesRegex(ValueError, 'grafanaNodePort'): r.grafana_node_port(self.config)
        # configs written before Prometheus/Grafana still render, with the "other" class
        del self.config['resources']['prometheus']
        self.assertEqual(r.observability_resource(self.config, 'prometheus'), r.OTHER_CLASS)
        self.config['resources']['grafana']['limits']['memory'] = '1Gi'
        with self.assertRaisesRegex(ValueError, 'Appendix B'): r.observability_resource(self.config, 'grafana')

    def assert_orang_c(self, objects, workloads):
        def pod(name):
            return next(x for x in workloads if x['metadata']['name'] == name)['spec']['template']
        for name, role, memory in [('field-report-processor', 'consumer', ('128Mi', '256Mi')),
                                   ('fire-processor', 'broker', ('512Mi', '1Gi'))]:
            template = pod(name)
            self.assertEqual(template['metadata']['labels']['role'], role, name)
            resources = template['spec']['containers'][0]['resources']
            self.assertEqual((resources['requests']['memory'], resources['limits']['memory']), memory)
            self.assertEqual(template['spec']['containers'][0]['readinessProbe']['httpGet']['path'], '/health/ready')
        processor_env = next(x for x in objects if x['kind'] == 'ConfigMap' and x['metadata']['name'] == 'field-report-processor-config')['data']
        self.assertEqual(processor_env['BNPB_GATEWAY_BASE_URL'], 'http://bnpb-aggregator:3000')
        self.assertNotIn('DATABASE_URL', processor_env)
        fire_env = next(x for x in objects if x['kind'] == 'ConfigMap' and x['metadata']['name'] == 'fire-processor-config')['data']
        self.assertEqual(fire_env['BNPB_GATEWAY_BASE_URL'], 'http://bnpb-aggregator:3000')
        # P4: one engine at a time; the next pod restores the stored snapshot
        fire = next(x for x in workloads if x['metadata']['name'] == 'fire-processor')
        self.assertEqual(fire['spec']['strategy'], {'type': 'Recreate'})
        topic = next(x for x in workloads if x['kind'] == 'Job' and x['metadata']['name'].startswith('kafka-topic-init'))
        command = topic['spec']['template']['spec']['containers'][0]['command'][-1]
        self.assertIn('"$FIELD_REPORT_TOPIC" --partitions 3 --replication-factor 1 --config retention.ms=2592000000', command)
        topic_env = next(x for x in objects if x['metadata']['name'] == 'kafka-topic-init-config')['data']
        self.assertEqual(topic_env['FIELD_REPORT_TOPIC'], 'field-reports')
        aggregator = pod('bnpb-aggregator')['spec']
        mount = next(m for m in aggregator['containers'][0]['volumeMounts'] if m['name'] == 'pvmbg-mapping')
        self.assertEqual(mount['mountPath'], '/app/config/pvmbg-mapping')
        self.assertNotIn('subPath', mount)
        self.assertIn({'name': 'pvmbg-mapping', 'configMap': {'name': 'pvmbg-mapping'}}, aggregator['volumes'])
        mapping = next(x for x in objects if x['kind'] == 'ConfigMap' and x['metadata']['name'] == 'pvmbg-mapping')
        self.assertEqual(json.loads(mapping['data']['mapping.json'])['label'], 'm1-contract')
        policies = {x['metadata']['name']: x['spec'] for x in objects if x['kind'] == 'NetworkPolicy'}
        def egress_apps(name):
            return {p['podSelector']['matchLabels']['app'] for rule in policies[name]['egress'] for p in rule.get('to', [])}
        kafka_from = {p['podSelector']['matchLabels']['app'] for rule in policies['kafka']['ingress'] for p in rule['from']}
        for name in ('bnpb-client-api', 'field-report-processor', 'fire-processor'):
            self.assertIn('kafka', egress_apps(name))
            self.assertIn(name, kafka_from)
        for name in ('field-report-processor', 'fire-processor'):
            # rule 5: the Canonical Store only through the Aggregator API
            self.assertEqual(egress_apps(name), {'kafka', 'bnpb-aggregator'})


if __name__ == '__main__': unittest.main()
