#!/usr/bin/env python3
"""Install local demo applications and send bounded real HTTP traffic."""
import argparse
from collections import Counter
from copy import deepcopy
import http.client
import ipaddress
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from server import atomic_json

ASSETS = Path(__file__).resolve().parent
MARKER = 'WORKER_DASHBOARD_DEMO'
PROFILES = {'api': (3, 0.7), 'store': (2, 0.9), 'reports': (3, 0.4)}


class API:
    def __init__(self, base, password_file):
        self.base = base.rstrip('/')
        self.url = urlsplit(self.base)
        if self.url.scheme != 'http' or self.url.hostname not in ('127.0.0.1', 'localhost', '::1'):
            raise ValueError('Use the local dashboard HTTP endpoint.')
        self.cookie = None
        self.call('login', {'password': Path(password_file).read_text().strip()})

    def call(self, endpoint, value=None):
        connection = http.client.HTTPConnection(self.url.hostname, self.url.port or 80, timeout=10)
        headers = {'Origin': self.base, 'X-Worker-Request': '1', 'Content-Type': 'application/json'}
        if self.cookie:
            headers['Cookie'] = self.cookie
        try:
            connection.request('GET' if value is None else 'POST', '/api/' + endpoint,
                               body=None if value is None else json.dumps(value), headers=headers)
            response = connection.getresponse()
            result = json.loads(response.read())
            if response.getheader('Set-Cookie'):
                self.cookie = response.getheader('Set-Cookie').split(';', 1)[0]
            if response.status >= 400:
                raise RuntimeError(f'Dashboard returned {response.status}: {result.get("error")}')
            return result
        finally:
            connection.close()


def choose_ports():
    sockets, addresses = [], []
    try:
        for preferred in range(18100, 18104):
            probe = socket.socket()
            sockets.append(probe)
            try:
                probe.bind(('127.0.0.1', preferred))
            except OSError:
                probe.bind(('127.0.0.1', 0))
            addresses.append(f'127.0.0.1:{probe.getsockname()[1]}')
        return addresses
    finally:
        for probe in sockets:
            probe.close()


def install(api):
    addresses = choose_ports()
    configs = {
        'api': {'type': 'python', 'protocol': 'asgi', 'path': str(ASSETS), 'processes': 2,
                'targets': {
                    'public': {'listen': addresses[0], 'module': 'api', 'callable': 'application'},
                    'admin': {'listen': addresses[1], 'module': 'api', 'callable': 'admin'},
                }},
        'store': {'type': 'php', 'listen': addresses[2], 'root': str(ASSETS / 'php'),
                  'script': 'index.php', 'processes': {'spare': 1, 'max': 3, 'idle_timeout': 10}},
        'reports': {'type': 'python', 'protocol': 'wsgi', 'path': str(ASSETS), 'module': 'reports',
                    'listen': addresses[3], 'processes': 1},
    }
    installed = []
    for role, value in configs.items():
        current = api.call('config')
        apps = current['config'].get('applications', {})
        name = 'demo-' + role
        suffix = 2
        while name in apps and apps[name].get('environment', {}).get(MARKER) != '1':
            name = f'demo-{role}-{suffix}'
            suffix += 1
        if name not in apps:
            value['environment'] = {MARKER: '1'}
            api.call('change/application', {'name': name, 'create': True,
                                            'revision': current['revision'], 'value': value})
        installed.append({'name': name, 'role': role})
    return installed


def endpoints(configuration, applications):
    result = {}
    for item in applications:
        config = configuration.get('applications', {}).get(item['name'], {})
        if config.get('environment', {}).get(MARKER) != '1':
            continue
        listeners = ([target.get('listen') for target in config['targets'].values()]
                     if config.get('targets') else [config.get('listen')])
        found = []
        for address in listeners:
            if not address or address.startswith('unix:'):
                continue
            if address.startswith('*:'):
                address = '127.0.0.1' + address[1:]
            try:
                parsed = urlsplit('http://' + address)
                host, port = parsed.hostname, parsed.port
                ip = ipaddress.ip_address(host)
                if ip.is_unspecified:
                    host = '::1' if ip.version == 6 else '127.0.0.1'
                elif not ip.is_loopback:
                    continue
                if port:
                    found.append((host, port))
            except ValueError:
                continue
        result[item['name']] = found
    return result


def running(state):
    pid_file = state / 'traffic.pid'
    if not pid_file.exists():
        return False
    try:
        pid = int(pid_file.read_text())
        command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
        return str(Path(__file__).resolve()).encode() in command and b'traffic' in command
    except (OSError, ValueError):
        return False


def traffic(args):
    state = args.state
    manifest = json.loads((state / 'manifest.json').read_text())
    api = API(args.dashboard, args.password_file)
    destinations = endpoints(api.call('config')['config'], manifest['applications'])
    lock, stop = threading.Lock(), threading.Event()
    observed = {item['name']: Counter() for item in manifest['applications']}
    started = time.monotonic()
    log_path = args.worker_log
    initial_log = log_path.stat().st_size if log_path and log_path.exists() else 0
    reason = 'duration reached'

    def client(item, index, serial):
        connection, previous = None, None
        sequence = serial * 7
        try:
            while not stop.is_set():
                tick = time.monotonic()
                with lock:
                    available = destinations.get(item['name'], [])
                if not available:
                    stop.wait(1)
                    continue
                address = available[index % len(available)]
                if address != previous or connection is None:
                    if connection:
                        connection.close()
                    connection = http.client.HTTPConnection(*address, timeout=5)
                    previous = address
                sequence += 1
                route = {0: '/unavailable', 1: '/missing', 2: '/redirect'}.get(sequence % 40,
                           '/daily' if item['role'] == 'reports' else '/catalog')
                try:
                    connection.request('GET', route + '?n=' + str(sequence),
                                       headers={'User-Agent': 'WorkerDashboardDemo/1', 'Accept': 'application/json'})
                    response = connection.getresponse()
                    response.read()
                    with lock:
                        observed[item['name']][str(response.status)] += 1
                except (OSError, http.client.HTTPException):
                    with lock:
                        observed[item['name']]['transport_errors'] += 1
                    connection.close()
                    connection = None
                wave = (1 + math.sin((tick - started) / 9 + serial / 3)) / 2
                period = PROFILES[item['role']][1] * (0.65 + wave)
                stop.wait(max(0.08, period - (time.monotonic() - tick)))
        finally:
            if connection:
                connection.close()

    threads = []
    for item in manifest['applications']:
        for index in range(PROFILES[item['role']][0]):
            thread = threading.Thread(target=client, args=(item, index, len(threads)), daemon=True)
            threads.append(thread)
            thread.start()

    def report(active):
        with lock:
            counts = deepcopy(observed)
        atomic_json(state / 'traffic.json', {'running': active, 'started_at': manifest['started_at'],
                    'updated_at': time.time(), 'duration_seconds': args.duration,
                    'elapsed_seconds': round(time.monotonic() - started, 1),
                    'stop_reason': None if active else reason,
                    'observed_responses': counts, 'clients': len(threads)})

    try:
        while time.monotonic() - started < args.duration:
            if (state / 'stop').exists():
                reason = 'stopped by user'
                break
            if log_path and log_path.exists() and log_path.stat().st_size - initial_log > 512 * 1024 * 1024:
                reason = 'debug log budget reached'
                break
            try:
                refreshed = endpoints(api.call('config')['config'], manifest['applications'])
                with lock:
                    destinations = refreshed
            except Exception:
                # Do not keep sending to stale addresses if configuration cannot be checked.
                with lock:
                    destinations = {}
            report(True)
            stop.wait(5)
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=6)
        report(False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['start', 'stop', 'status', 'traffic'])
    parser.add_argument('--state', type=Path, default=ROOT / '.state/demo')
    parser.add_argument('--dashboard', default='http://127.0.0.1:8090')
    parser.add_argument('--password-file', type=Path, default=ROOT / '.state/admin-password')
    parser.add_argument('--worker-log', type=Path, help='Optional Worker debug log growth limit')
    parser.add_argument('--duration', type=int, default=1800)
    args = parser.parse_args()
    if args.duration < 1 or args.duration > 3600:
        parser.error('--duration must be between 1 and 3600 seconds')
    args.state = args.state.resolve()
    args.state.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.action == 'traffic':
        return traffic(args)
    if args.action == 'stop':
        (args.state / 'stop').touch(mode=0o600)
        print('Traffic will stop after the current requests finish. Demo applications remain configured.')
        return
    if args.action == 'status':
        report_file = args.state / 'traffic.json'
        report = json.loads(report_file.read_text()) if report_file.exists() else {}
        report['running'] = running(args.state)
        print(json.dumps(report, indent=2))
        return
    if running(args.state):
        print('Demo traffic is already running. Use status or stop.')
        return
    api = API(args.dashboard, args.password_file)
    applications = install(api)
    atomic_json(args.state / 'manifest.json', {'applications': applications, 'started_at': time.time()})
    (args.state / 'stop').unlink(missing_ok=True)
    with (args.state / 'traffic.log').open('ab') as output:
        process = subprocess.Popen([
            sys.executable, str(Path(__file__).resolve()), 'traffic', '--state', str(args.state),
            '--dashboard', args.dashboard, '--password-file', str(args.password_file.resolve()),
            '--duration', str(args.duration),
            *(['--worker-log', str(args.worker_log.resolve())] if args.worker_log else []),
        ], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    (args.state / 'traffic.pid').write_text(str(process.pid) + '\n')
    time.sleep(0.2)
    if process.poll() is not None:
        raise RuntimeError('Traffic worker failed to start; inspect ' + str(args.state / 'traffic.log'))
    print(json.dumps({'applications': applications, 'duration_seconds': args.duration,
                      'dashboard': args.dashboard, 'state': str(args.state)}, indent=2))


if __name__ == '__main__':
    main()
