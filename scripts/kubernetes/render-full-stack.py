#!/usr/bin/env python3
"""Render the complete BNPB deployment without placing credentials in Git."""

import json
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

ROOT = Path(__file__).resolve().parents[2]
APPS = [
    "bnpb-auth", "bnpb-client-api", "bnpb-aggregator",
    "dashboard-consumer", "notification-consumer", "bmkg", "pvmbg",
]
STORES = {
    "auth-store": "bnpb-auth",
    "dashboard-store": "dashboard-consumer",
    "notification-store": "notification-consumer",
    "bmkg-store": "bmkg",
    "pvmbg-store": "pvmbg",
}
PORTS = {
    "bnpb-auth": 3000, "bnpb-client-api": 3000, "bnpb-aggregator": 3000,
    "dashboard-consumer": 3000, "notification-consumer": 3000,
    "bmkg": 8081, "pvmbg": 8082, "sensor-pantai": 8080,
}
NODE_PORTS = {
    "bnpb-client-api": 30000, "bnpb-auth": 30001,
    "bnpb-aggregator": 30003, "dashboard-consumer": 30004,
    "notification-consumer": 30005,
}
MONGO_APPS = ["canonical-config", "canonical-shard-a", "canonical-shard-b", "canonical-store"]
REQUIRED_RESOURCES = [
    "mongo-member", "mongo-router", "mongo-init", "mongo-migrate",
    "postgres", "kafka", "kafka-topic-init", *APPS, "sensor-pantai",
]
MEMORY_LIMITS = {
    "mongo-member": ("512Mi", "1Gi"), "mongo-router": ("128Mi", "256Mi"),
    "mongo-init": ("128Mi", "256Mi"), "mongo-migrate": ("128Mi", "256Mi"),
    "postgres": ("512Mi", "1Gi"), "kafka": ("512Mi", "1Gi"),
    "kafka-topic-init": ("128Mi", "256Mi"),
    "bnpb-auth": ("128Mi", "256Mi"), "bnpb-client-api": ("128Mi", "256Mi"),
    "bnpb-aggregator": ("256Mi", "512Mi"),
    "dashboard-consumer": ("128Mi", "256Mi"),
    "notification-consumer": ("128Mi", "256Mi"),
    "bmkg": ("64Mi", "128Mi"), "pvmbg": ("64Mi", "128Mi"),
    "sensor-pantai": ("128Mi", "256Mi"),
}


def run(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True)


def kubectl_objects(filename):
    output = run("kubectl", "create", "--dry-run=client", "--validate=false",
                 "-f", str(ROOT / "k8s" / filename), "-o", "json")
    decoder = json.JSONDecoder()
    objects = []
    while output.strip():
        obj, used = decoder.raw_decode(output.lstrip())
        obj["metadata"].pop("namespace", None)
        objects.append(obj)
        output = output.lstrip()[used:]
    return objects


def write(output, name, items):
    path = output / (name + ".json")
    path.touch(mode=0o600, exist_ok=True)
    path.chmod(0o600)
    path.write_text(json.dumps(
        {"apiVersion": "v1", "kind": "List", "items": items}, indent=2
    ) + "\n")


def resource(config, name):
    value = config["resources"].get(name)
    if not isinstance(value, dict):
        raise ValueError("Missing Appendix B resource values for " + name)
    for side in ("requests", "limits"):
        if not isinstance(value.get(side), dict):
            raise ValueError(name + " needs resources." + side)
        if not value[side].get("memory"):
            raise ValueError(name + " needs " + side + ".memory")
        if "cpu" in value[side] and not value[side]["cpu"]:
            raise ValueError(name + " has empty " + side + ".cpu")
    expected_request, expected_limit = MEMORY_LIMITS[name]
    if (value["requests"]["memory"], value["limits"]["memory"]) != (expected_request, expected_limit):
        raise ValueError(name + " memory resources do not match Appendix B")
    return value


def validate_connections(services):
    for store, owner in STORES.items():
        db = services[store]["environment"]
        uri = urlparse(services[owner]["environment"]["DATABASE_URL"])
        if (uri.hostname != store or unquote(uri.username or "") != db["POSTGRES_USER"]
                or unquote(uri.password or "") != db["POSTGRES_PASSWORD"]
                or uri.path.lstrip("/") != db["POSTGRES_DB"]):
            raise ValueError(owner + " DATABASE_URL must use only its own PostgreSQL store and credentials")
    mongo = urlparse(services["bnpb-aggregator"]["environment"]["DATABASE_URL"])
    router = services["canonical-store"]["environment"]
    if (mongo.hostname != "canonical-store"
            or unquote(mongo.username or "") != router["CANONICAL_STORE_DB_USER"]
            or unquote(mongo.password or "") != router["CANONICAL_STORE_DB_PASSWORD"]):
        raise ValueError("Aggregator DATABASE_URL must use canonical-store and its application credentials")
    if (services["bnpb-aggregator"]["environment"]["BMKG_API_KEY"]
            not in services["bmkg"]["environment"]["BMKG_API_KEYS"].split(",")):
        raise ValueError("Aggregator BMKG key does not match BMKG_API_KEYS")
    if (services["bnpb-aggregator"]["environment"]["PVMBG_TOKEN"]
            not in services["pvmbg"]["environment"]["PVMBG_CLIENT_TOKENS"].split(",")):
        raise ValueError("Aggregator PVMBG token does not match PVMBG_CLIENT_TOKENS")
    if (services["bnpb-aggregator"]["environment"]["SENSOR_PANTAI_TOKEN"]
            != services["sensor-pantai"]["environment"]["PANTAI_AUTH_TOKEN"]):
        raise ValueError("Aggregator sensor token does not match PANTAI_AUTH_TOKEN")


def is_secret(key):
    return key == "DATABASE_URL" or bool(re.search(
        r"(PASSWORD|TOKENS?|API_KEYS?|PRIVATE_KEY|CLUSTER_KEY)$", key))


def validate_no_demo_secrets(services, examples):
    for name, service in services.items():
        for key, value in service.get("environment", {}).items():
            if (is_secret(key) and value
                    and value == examples[name].get("environment", {}).get(key)):
                raise ValueError(name + " still uses the .env.example value for " + key)


def labels(name):
    role = ("store" if name in STORES or name in MONGO_APPS[:3] else
            "aggregator" if name == "bnpb-aggregator" else
            "api" if name in ("bnpb-auth", "bnpb-client-api") else
            "consumer" if name.endswith("-consumer") else
            "mock" if name in ("bmkg", "pvmbg") else
            "broker" if name == "kafka" else
            "sensor" if name == "sensor-pantai" else "other")
    return {"app": name, "part-of": "bnpb", "role": role}


def validate_config(config):
    if config.get("namespace") != "sistem-informasi-kebencanaan-bnpb":
        raise ValueError("Use namespace sistem-informasi-kebencanaan-bnpb")
    if not config.get("context"):
        raise ValueError("Set an explicit Kubernetes context")
    groups = config.get("storageNodes", {})
    nodes = []
    for shard in ("a", "b"):
        group = groups.get(shard, [])
        if len(group) != 3 or len(set(group)) != 3:
            raise ValueError("Each storageNodes group needs three distinct node hostnames")
        nodes.extend(group)
    if len(set(nodes)) != 6:
        raise ValueError("Shard groups must be disjoint: a node may not store both shards")
    if config.get("stableNodeName") not in nodes:
        raise ValueError("stableNodeName must be one of the six configured nodes")


def service(name, port, target=None, node_port=None):
    spec = {
        "selector": {"app": name},
        "ports": [{"name": "tcp", "port": port, "targetPort": target or port}],
    }
    if node_port:
        spec["type"] = "NodePort"
        spec["ports"][0]["nodePort"] = node_port
    return {"apiVersion": "v1", "kind": "Service", "metadata": {"name": name}, "spec": spec}


def env_objects(name, values):
    public, private = {}, {}
    for key, value in values.items():
        if is_secret(key):
            private[key] = str(value)
        else:
            public[key] = str(value)
    objects = []
    refs = []
    if public:
        objects.append({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": name + "-config"}, "data": public})
        refs.append({"configMapRef": {"name": name + "-config"}})
    if private:
        objects.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": name + "-secret"}, "type": "Opaque", "stringData": private})
        refs.append({"secretRef": {"name": name + "-secret"}})
    return objects, refs


def deployment(name, image, env, resources, port, replicas=1, volume=None, command=None, node_name=None):
    container = {
        "name": name, "image": image, "imagePullPolicy": "Always",
        "ports": [{"name": "http", "containerPort": port}],
        "envFrom": env, "resources": resources,
        "readinessProbe": {"httpGet": {
            "path": "/health" if name in ("bmkg", "pvmbg") else "/health/ready",
            "port": port}, "periodSeconds": 3, "timeoutSeconds": 3, "failureThreshold": 2},
    }
    if command:
        container["command"] = command
    if name == "bnpb-aggregator":
        container["startupProbe"] = {"httpGet": {"path": "/health/live", "port": port},
                                     "periodSeconds": 3, "failureThreshold": 40}
        container["livenessProbe"] = {"httpGet": {"path": "/health/live", "port": port},
                                      "periodSeconds": 10, "timeoutSeconds": 3, "failureThreshold": 3}
        container["lifecycle"] = {"preStop": {
            "exec": {"command": ["sh", "-c", "sleep 5"]}}}
    if volume:
        container["volumeMounts"] = [{"name": "data", "mountPath": volume}]
    spec = {"containers": [container]}
    if node_name:
        spec["nodeSelector"] = {"kubernetes.io/hostname": node_name}
    if name == "bnpb-aggregator":
        spec["terminationGracePeriodSeconds"] = 60
        spec["topologySpreadConstraints"] = [{
            "maxSkew": 1, "topologyKey": "kubernetes.io/hostname",
            "whenUnsatisfiable": "DoNotSchedule",
            "labelSelector": {"matchLabels": {"app": name}},
        }]
    if volume:
        spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": name + "-data"}}]
    result = {
        "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name},
        "spec": {"replicas": replicas, "selector": {"matchLabels": {"app": name}},
                 "template": {"metadata": {"labels": labels(name)}, "spec": spec}},
    }
    if name == "bnpb-aggregator":
        result["spec"]["strategy"] = {"type": "RollingUpdate", "rollingUpdate": {
            "maxUnavailable": 0, "maxSurge": 1}}
    return result


def stateful(name, image, env, resources, port, mount, size, storage_class, command=None, node_name=None):
    container = {
        "name": name, "image": image, "ports": [{"name": "tcp", "containerPort": port}],
        "envFrom": env, "resources": resources,
        "volumeMounts": [{"name": "data", "mountPath": mount}],
    }
    if command:
        container["command"] = command
    if name.endswith("-store"):
        container["readinessProbe"] = {
            "exec": {"command": ["sh", "-c", "pg_isready -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\""]},
            "periodSeconds": 10, "failureThreshold": 12,
        }
    if name == "kafka":
        container["readinessProbe"] = {
            "exec": {"command": ["bash", "-ec",
                "kafka-topics --bootstrap-server localhost:29092 --list >/dev/null"]},
            # Starting the Kafka JVM CLI routinely exceeds the one-second default.
            "periodSeconds": 10, "timeoutSeconds": 10, "failureThreshold": 12,
        }
    if name == "sensor-pantai":
        container["readinessProbe"] = {
            "httpGet": {"path": "/healthz", "port": port},
            "periodSeconds": 10, "failureThreshold": 12,
        }
    pvc_spec = {"accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": size}}}
    if storage_class:
        pvc_spec["storageClassName"] = storage_class
    pod_spec = {"containers": [container]}
    if node_name:
        pod_spec["nodeSelector"] = {"kubernetes.io/hostname": node_name}
    return {
        "apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": name},
        "spec": {
            "serviceName": name, "replicas": 1, "selector": {"matchLabels": {"app": name}},
            "template": {"metadata": {"labels": labels(name)}, "spec": pod_spec},
            "volumeClaimTemplates": [{"metadata": {"name": "data"}, "spec": pvc_spec}],
        },
    }


def policy(name, ingress=None, egress=None):
    return {
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
        "metadata": {"name": name},
        "spec": {"podSelector": {"matchLabels": {"app": name}}, "policyTypes": ["Ingress", "Egress"],
                 "ingress": ingress or [], "egress": egress or []},
    }


def peers(names, port):
    return [{"from": [{"podSelector": {"matchLabels": {"app": name}}} for name in names],
             "ports": [{"protocol": "TCP", "port": port}]}]


def destinations(names, port):
    return [{"to": [{"podSelector": {"matchLabels": {"app": name}}} for name in names],
             "ports": [{"protocol": "TCP", "port": port}]}]


def main():
    if len(sys.argv) != 4:
        raise SystemExit("Usage: render-full-stack.py CONFIG_JSON SECRETS_ENV OUTPUT_DIRECTORY")
    config_path, secret_path, output = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    config = json.loads(config_path.read_text())
    validate_config(config)
    for name in REQUIRED_RESOURCES:
        resource(config, name)
    repository = config["imageRepository"].rstrip("/")
    tag = config["imageTag"]
    stable_node = config.get("stableNodeName")
    if not stable_node:
        raise ValueError("Set stableNodeName to the schedulable control-plane VM hostname")
    if "YOUR_USER" in repository or tag == "CHANGE_ME":
        raise ValueError("Set imageRepository and imageTag in the deployment config")
    if not secret_path.is_file():
        raise ValueError("Missing Kubernetes credential file: " + str(secret_path))
    if secret_path.stat().st_mode & 0o077:
        raise ValueError("Restrict credential file permissions: chmod 600 " + str(secret_path))
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    compose = json.loads(run("docker", "compose", "--env-file", str(secret_path.resolve()), "config", "--format", "json"))
    services = compose["services"]
    examples = json.loads(run("docker", "compose", "--env-file", str(ROOT / ".env.example"), "config", "--format", "json"))
    validate_no_demo_secrets(services, examples["services"])
    validate_connections(services)
    image = lambda name: repository + ":" + name + "-" + tag
    objects = []
    infra = []
    applications = []

    # The Mongo bootstrap Secret is restricted to Mongo Pods and bootstrap Jobs.
    root = services["canonical-config-1"]["environment"]
    router = services["canonical-store"]["environment"]
    root_user = root["MONGO_INITDB_ROOT_USERNAME"]
    root_password = root["MONGO_INITDB_ROOT_PASSWORD"]
    mongo_secret = {
        **root, "CANONICAL_STORE_DB_NAME": router["CANONICAL_STORE_DB_NAME"],
        "CANONICAL_STORE_DB_USER": router["CANONICAL_STORE_DB_USER"],
        "CANONICAL_STORE_DB_PASSWORD": router["CANONICAL_STORE_DB_PASSWORD"],
        "DATABASE_URL": "mongodb://" + quote(root_user, safe="") + ":" +
        quote(root_password, safe="") + "@canonical-store:27017/?authSource=admin",
    }
    objects.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "canonical-mongo"},
                    "type": "Opaque", "stringData": {k: str(v) for k, v in mongo_secret.items()}})

    mongo_items = kubectl_objects("mongo.yaml")
    for obj in mongo_items:
        kind, name = obj["kind"], obj["metadata"]["name"]
        if kind in ("StatefulSet", "Deployment"):
            pod = obj["spec"]["template"]
            pod["metadata"]["labels"].update(labels(name))
            pod["spec"]["containers"][0]["resources"] = resource(
                config, "mongo-member" if kind == "StatefulSet" else "mongo-router")
            if kind == "StatefulSet":
                group = config["storageNodes"]["b" if name == "canonical-shard-b" else "a"]
                pod["spec"]["affinity"]["nodeAffinity"] = {
                    "requiredDuringSchedulingIgnoredDuringExecution": {"nodeSelectorTerms": [{
                        "matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": group}]
                    }]}}
                for claim in obj["spec"]["volumeClaimTemplates"]:
                    if config.get("storageClassName"):
                        claim["spec"]["storageClassName"] = config["storageClassName"]
    write(output, "mongo", mongo_items)

    for filename, name in (("replica-init", "canonical-replica-init"),
                           ("sharding-init", "canonical-sharding-init"),
                           ("migrate", "canonical-migrate")):
        obj = kubectl_objects(filename + ".yaml")[0]
        obj["spec"]["template"]["metadata"] = {"labels": labels(name)}
        container = obj["spec"]["template"]["spec"]["containers"][0]
        container["resources"] = resource(config, "mongo-migrate" if filename == "migrate" else "mongo-init")
        if filename == "migrate":
            container["image"] = image("bnpb-aggregator")
            suffix = hashlib.sha256(container["image"].encode()).hexdigest()[:10]
            obj["metadata"]["name"] = "canonical-migrate-" + suffix
        obj["spec"]["activeDeadlineSeconds"] = 900
        if config.get("imagePullSecret"):
            obj["spec"]["template"]["spec"]["imagePullSecrets"] = [{"name": config["imagePullSecret"]}]
        version = json.dumps(obj["spec"], sort_keys=True) + "".join(
            (ROOT / "scripts/mongodb" / f).read_text()
            for f in ("start.sh", "init-replica-sets.js", "init-sharding.js"))
        obj["metadata"]["name"] = name + "-" + hashlib.sha256(version.encode()).hexdigest()[:10]
        write(output, filename + "-job", [obj])

    for store in STORES:
        env = services[store]["environment"].copy()
        env["PGDATA"] = "/var/lib/postgresql/data/pgdata"
        env_objs, refs = env_objects(store, env)
        objects += env_objs
        infra.append(service(store, 5432))
        infra.append(stateful(store, "postgres:16-alpine", refs, resource(config, "postgres"),
                                  5432, "/var/lib/postgresql/data", "5Gi", config.get("storageClassName"),
                                  node_name=stable_node))

    kafka_env = services["kafka"]["environment"].copy()
    kafka_env["KAFKA_LISTENERS"] = "PLAINTEXT://0.0.0.0:29092,CONTROLLER://0.0.0.0:29093"
    kafka_env["KAFKA_ADVERTISED_LISTENERS"] = "PLAINTEXT://kafka:29092"
    kafka_env["KAFKA_LISTENER_SECURITY_PROTOCOL_MAP"] = "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT"
    kafka_env["KAFKA_CONTROLLER_QUORUM_VOTERS"] = "1@localhost:29093"
    env_objs, refs = env_objects("kafka", kafka_env)
    objects += env_objs
    infra.append(service("kafka", 29092))
    infra.append(stateful("kafka", "confluentinc/cp-kafka:7.7.1", refs, resource(config, "kafka"),
                              29092, "/var/lib/kafka/data", "10Gi", config.get("storageClassName"),
                              node_name=stable_node))

    sensor_env = services["sensor-pantai"]["environment"]
    env_objs, refs = env_objects("sensor-pantai", sensor_env)
    objects += env_objs
    sensor_image = services["sensor-pantai"]["image"]
    infra.append(service("sensor-pantai", 8080))
    infra.append(stateful("sensor-pantai", sensor_image, refs, resource(config, "sensor-pantai"),
                              8080, "/data", "2Gi", config.get("storageClassName"),
                              node_name=stable_node))

    for name in APPS:
        env = services[name]["environment"].copy()
        env["NODE_ENV"] = "production"
        if name == "bnpb-client-api":
            env["BNPB_GATEWAY_BASE_URL"] = "http://bnpb-aggregator:3000"
        if name == "bnpb-aggregator":
            env["MONGO_NODE_MAP"] = "{}"
            env["SENSOR_PANTAI_BASE_URL"] = "http://sensor-pantai:8080"
        if name == "dashboard-consumer":
            env["CANONICAL_ANALYTICS_URL"] = "http://bnpb-aggregator:3000/internal/analytics"
            env["BNPB_INTERNAL_API_KEY"] = services["bnpb-aggregator"]["environment"]["BNPB_INTERNAL_API_KEY"]
        env_objs, refs = env_objects(name, env)
        objects += env_objs
        applications.append(service(name, PORTS[name], node_port=NODE_PORTS.get(name)))
        applications.append(deployment(name, image(name), refs, resource(config, name), PORTS[name],
                                    replicas=3 if name == "bnpb-aggregator" else 1,
                                    node_name=None if name == "bnpb-aggregator" else stable_node))
        if name == "bnpb-aggregator":
            applications[-1]["spec"]["template"]["spec"]["serviceAccountName"] = "aggregator-topology"
    applications.append({
        "apiVersion": "policy/v1", "kind": "PodDisruptionBudget",
        "metadata": {"name": "bnpb-aggregator"},
        "spec": {"minAvailable": 2, "selector": {"matchLabels": {"app": "bnpb-aggregator"}}},
    })

    # Kubernetes Service load balancing replaces the Compose-only HAProxy.
    applications.append({"apiVersion": "v1", "kind": "Service",
                      "metadata": {"name": "bnpb-aggregator-entry"},
                      "spec": {"selector": {"app": "bnpb-aggregator"},
                               "ports": [{"port": 3000, "targetPort": 3000}]}})
    topic_env = {"KAFKA_INTERNAL_BOOTSTRAP_SERVER": "kafka:29092",
                 "KAFKA_TOPIC": services["kafka-topic-init"]["environment"]["KAFKA_TOPIC"],
                 "SATELLITE_RAW_TOPIC": services["kafka-topic-init"]["environment"]["SATELLITE_RAW_TOPIC"]}
    env_objs, refs = env_objects("kafka-topic-init", topic_env)
    objects += env_objs
    topic_job = {
        "apiVersion": "batch/v1", "kind": "Job", "metadata": {"name": "kafka-topic-init"},
        "spec": {"backoffLimit": 5, "activeDeadlineSeconds": 600, "template": {"metadata": {"labels": labels("kafka-topic-init")},
                "spec": {"restartPolicy": "OnFailure", "containers": [{
                    "name": "topic", "image": "confluentinc/cp-kafka:7.7.1",
                    "envFrom": refs, "resources": resource(config, "kafka-topic-init"),
                    "command": ["bash", "-ec",
                        "until kafka-topics --bootstrap-server \"$KAFKA_INTERNAL_BOOTSTRAP_SERVER\" --list; do sleep 5; done; "
                        "kafka-topics --bootstrap-server \"$KAFKA_INTERNAL_BOOTSTRAP_SERVER\" "
                        "--create --if-not-exists --topic \"$KAFKA_TOPIC\" --partitions 1 --replication-factor 1; "
                        "kafka-topics --bootstrap-server \"$KAFKA_INTERNAL_BOOTSTRAP_SERVER\" "
                        "--create --if-not-exists --topic \"$SATELLITE_RAW_TOPIC\" --partitions 1 --replication-factor 1 --config retention.ms=-1"],
                }]}}},
    }
    objects += [
        {"apiVersion": "v1", "kind": "ServiceAccount", "metadata": {"name": "aggregator-topology"}},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "Role", "metadata": {"name": "aggregator-topology"},
         "rules": [{"apiGroups": [""], "resources": ["pods"], "verbs": ["get", "list"]}]},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": "aggregator-topology"},
         "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "Role", "name": "aggregator-topology"},
         "subjects": [{"kind": "ServiceAccount", "name": "aggregator-topology", "namespace": config["namespace"]}]},
    ]
    pull_secret = config.get("imagePullSecret")
    configs = {obj["metadata"]["name"]: obj.get("data", obj.get("stringData", {}))
               for obj in objects if obj["kind"] in ("Secret", "ConfigMap")}
    for obj in mongo_items + infra + applications + [topic_job]:
        template = obj.get("spec", {}).get("template")
        if not template:
            continue
        if pull_secret:
            template["spec"]["imagePullSecrets"] = [{"name": pull_secret}]
        values = {}
        for container in template["spec"]["containers"]:
            for ref in container.get("envFrom", []):
                for kind in ("configMapRef", "secretRef"):
                    if kind in ref:
                        name = ref[kind]["name"]
                        values[name] = configs[name]
        template["metadata"].setdefault("annotations", {})["bnpb/config-hash"] = hashlib.sha256(
            json.dumps(values, sort_keys=True).encode()).hexdigest()
    # mongo was initially written before the common image-pull configuration.
    write(output, "mongo", mongo_items)
    write(output, "config", objects)
    write(output, "infra", infra)
    write(output, "applications", applications)
    topic_job["metadata"]["name"] += "-" + hashlib.sha256(
        json.dumps(topic_job["spec"], sort_keys=True).encode()).hexdigest()[:10]
    write(output, "kafka-job", [topic_job])

    # Default deny plus explicit service graph. Storage ingress is limited to its owner.
    policies = [{
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
        "metadata": {"name": "default-deny"},
        "spec": {"podSelector": {}, "policyTypes": ["Ingress", "Egress"]},
    }, {
        "apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy",
        "metadata": {"name": "allow-dns"},
        "spec": {"podSelector": {}, "policyTypes": ["Egress"],
                 "egress": [{"to": [{"namespaceSelector": {"matchLabels": {
                     "kubernetes.io/metadata.name": "kube-system"}}}],
                             "ports": [{"protocol": proto, "port": 53} for proto in ("UDP", "TCP")]}]},
    }]
    mongo_peers = MONGO_APPS + ["canonical-replica-init", "canonical-sharding-init", "canonical-migrate"]
    for name in MONGO_APPS:
        ingress_from = mongo_peers + ["bnpb-aggregator"]
        policies.append(policy(name, peers(ingress_from, 27017), destinations(MONGO_APPS, 27017)))
    for name in ("canonical-replica-init", "canonical-sharding-init", "canonical-migrate"):
        policies.append(policy(name, egress=destinations(MONGO_APPS, 27017)))
    for store, owner in STORES.items():
        policies.append(policy(store, peers([owner], 5432)))
    kafka_users = ["bnpb-aggregator", "dashboard-consumer", "notification-consumer", "kafka-topic-init"]
    policies.append(policy("kafka", peers(kafka_users, 29092)))
    policies.append(policy("kafka-topic-init", egress=destinations(["kafka"], 29092)))
    policies.append(policy("sensor-pantai", peers(["bnpb-aggregator"], 8080)))
    policies.append(policy("bmkg", peers(["bnpb-aggregator"], 8081), destinations(["bmkg-store"], 5432)))
    policies.append(policy("pvmbg", peers(["bnpb-aggregator"], 8082), destinations(["pvmbg-store"], 5432)))
    policies.append(policy("bnpb-auth", peers(["bnpb-client-api"], 3000) + [{}],
                           destinations(["auth-store"], 5432)))
    policies.append(policy("bnpb-aggregator", peers(["bnpb-client-api"], 3000) + [{}],
                           destinations(MONGO_APPS, 27017) +
                           destinations(["kafka"], 29092) +
                           destinations(["bmkg"], 8081) +
                           destinations(["pvmbg"], 8082) +
                           destinations(["sensor-pantai"], 8080) +
                           [{"ports": [{"protocol": "TCP", "port": 443}, {"protocol": "TCP", "port": 6443}]}]))
    policies.append(policy("bnpb-client-api", [{}],
                           destinations(["bnpb-auth", "bnpb-aggregator"], 3000)))
    for name, store in (("dashboard-consumer", "dashboard-store"),
                        ("notification-consumer", "notification-store")):
        policies.append(policy(name, [{}],
                               destinations([store], 5432) + destinations(["kafka"], 29092) +
                               (destinations(["bnpb-aggregator"], 3000) if name == "dashboard-consumer" else [])))
    write(output, "policies", policies)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
