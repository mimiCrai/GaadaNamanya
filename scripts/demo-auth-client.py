#!/usr/bin/env python3
"""Demo requests for BNPB Auth and BNPB Client API (Python standard library)."""
import argparse
import getpass
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def env_file():
    path = Path(__file__).resolve().parent.parent / '.env'
    values = {}
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition('=')
            if sep and not key.startswith('#'):
                values[key.strip()] = value.strip().strip('"\'')
    return values


def request(method, url, body=None, token=None):
    headers = {}
    if body is not None:
        headers['Content-Type'] = 'application/json'
        body = json.dumps(body).encode()
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = Request(url, data=body, headers=headers, method=method)
    start = time.perf_counter()
    try:
        try:
            response = urlopen(req, timeout=30)
        except HTTPError as error:
            response = error
        with response:
            status = response.status
            raw = response.read().decode('utf-8', errors='replace')
    except (URLError, TimeoutError) as error:
        print(f'{method} {url}\nKoneksi gagal: {error}\n', file=sys.stderr)
        return None, None
    elapsed = time.perf_counter() - start
    try:
        data = json.loads(raw)
        display = json.dumps(data, indent=2, ensure_ascii=False)
    except json.JSONDecodeError:
        data, display = None, raw
    print(f'\n{method} {url}\n{display}\nHTTP {status} | Latensi total {elapsed:.6f} detik')
    return status, data


def main():
    values = env_file()
    parser = argparse.ArgumentParser(description='Demo BNPB Auth dan Client API')
    parser.add_argument('action', choices=['health', 'register', 'login'])
    parser.add_argument('--email', help='Email untuk register atau login')
    parser.add_argument('--source', choices=['BMKG', 'PVMBG'], help='Filter hazard berdasarkan sumber')
    parser.add_argument('--auth-url', default=os.getenv('AUTH_BASE_URL', f"http://localhost:{values.get('BNPB_AUTH_HOST_PORT', '3001')}"))
    parser.add_argument('--client-url', default=os.getenv('CLIENT_API_BASE_URL', f"http://localhost:{values.get('BNPB_CLIENT_API_HOST_PORT', '3000')}"))
    args = parser.parse_args()
    auth = args.auth_url.rstrip('/')
    client = args.client_url.rstrip('/')
    if args.action == 'health':
        statuses = [request('GET', f'{base}/health/live')[0] for base in (auth, client)]
        return 0 if all(status == 200 for status in statuses) else 1
    if not args.email:
        parser.error('--email diperlukan untuk register atau login')
    password = getpass.getpass('Password: ')
    status, data = request('POST', f'{auth}/auth/{args.action}', {'email': args.email, 'password': password})
    token = (data or {}).get('data', {}).get('accessToken') if isinstance(data, dict) else None
    if status not in (200, 201) or not token:
        print('Autentikasi gagal atau access token tidak ditemukan.', file=sys.stderr)
        return 1
    url = f'{client}/hazards'
    if args.source:
        url += f'?source={args.source}'
    status, _ = request('GET', url, token=token)
    return 0 if status == 200 else 1


if __name__ == '__main__':
    sys.exit(main())
