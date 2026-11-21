#!/usr/bin/env python3
"""Create a private .env.k8s with consistent random demo-cluster credentials."""

import base64
import os
import secrets
import subprocess
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / ".env.k8s"


def random_password():
    return secrets.token_urlsafe(32)


def main():
    if TARGET.exists():
        raise SystemExit(".env.k8s already exists; it was not overwritten")
    private_key = subprocess.check_output(
        ["openssl", "genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"],
        stderr=subprocess.DEVNULL,
        text=True,
    ).replace("\n", "\\n")
    values = {
        "CANONICAL_STORE_ROOT_PASSWORD": random_password(),
        "CANONICAL_STORE_CLUSTER_KEY": base64.b64encode(os.urandom(48)).decode(),
        "CANONICAL_STORE_DB_PASSWORD": random_password(),
        "AUTH_STORE_DB_PASSWORD": random_password(),
        "DASHBOARD_STORE_DB_PASSWORD": random_password(),
        "NOTIFICATION_STORE_DB_PASSWORD": random_password(),
        "BMKG_STORE_DB_PASSWORD": random_password(),
        "PVMBG_STORE_DB_PASSWORD": random_password(),
        "BNPB_AUTH_JWT_PRIVATE_KEY": private_key,
        "BNPB_AGGREGATOR_AUDIT_TOKEN": random_password(),
        "BNPB_AGGREGATOR_INTERNAL_API_KEY": random_password(),
        "PANTAI_AUTH_TOKEN": random_password(),
        # The real feed token is issued externally; never reuse the example token.
        "BNPB_AGGREGATOR_SATELLITE_TOKEN": "",
    }
    bmkg_key = "bmkg_demo_" + secrets.token_hex(16)
    pvmbg_token = "pvmbg.bnpb." + secrets.token_hex(16)
    values["BNPB_AGGREGATOR_BMKG_API_KEY"] = bmkg_key
    values["BMKG_API_KEYS"] = bmkg_key
    values["BNPB_AGGREGATOR_PVMBG_TOKEN"] = pvmbg_token
    values["PVMBG_CLIENT_TOKENS"] = pvmbg_token

    def postgres_url(store, host, db):
        password = quote(values[store + "_DB_PASSWORD"], safe="")
        return "postgresql://postgres:" + password + "@" + host + ":5432/" + db

    values["BNPB_AGGREGATOR_DATABASE_URL"] = (
        "mongodb://bnpb:" + quote(values["CANONICAL_STORE_DB_PASSWORD"], safe="") +
        "@canonical-store:27017/canonical_store?authSource=canonical_store"
    )
    values["DASHBOARD_CONSUMER_DATABASE_URL"] = postgres_url("DASHBOARD_STORE", "dashboard-store", "dashboard")
    values["NOTIFICATION_CONSUMER_DATABASE_URL"] = postgres_url(
        "NOTIFICATION_STORE", "notification-store", "notifications")
    values["BMKG_DATABASE_URL"] = postgres_url("BMKG_STORE", "bmkg-store", "bmkg")
    values["PVMBG_DATABASE_URL"] = postgres_url("PVMBG_STORE", "pvmbg-store", "pvmbg")

    lines = []
    for line in (ROOT / ".env.example").read_text().splitlines():
        key = line.split("=", 1)[0] if "=" in line and not line.lstrip().startswith("#") else None
        lines.append(key + "=" + values[key] if key in values else line)
    fd = os.open(TARGET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write("\n".join(lines) + "\n")
    print("Created .env.k8s with mode 0600. Keep a protected backup.")


if __name__ == "__main__":
    main()
