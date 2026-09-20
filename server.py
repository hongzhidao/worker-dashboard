#!/usr/bin/env python3
"""Worker dashboard: authenticated HTTP UI and a Unix control socket client."""

import argparse
from collections import deque
from copy import deepcopy
import hashlib
import hmac
import http.client
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import threading
import time
from urllib.parse import quote, urlsplit


WEB = Path(__file__).with_name('web')
MAX_BODY = 2 * 1024 * 1024
LOG = logging.getLogger('worker.dashboard')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8')


def revision(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest()


def application_revision(configuration):
    value = deepcopy(configuration)
    value.pop('listen', None)
    for target in value.get('targets', {}).values():
        target.pop('listen', None)
    return revision(value)


def counter_rate(current, previous, elapsed):
    if (type(current) is not int or type(previous) is not int
            or previous < 0 or current < previous):
        return None
    return round((current - previous) / elapsed, 2)


def atomic_json(path, value):
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'wb') as output:
        output.write(encoded(value))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


class APIError(Exception):
    def __init__(self, status, message, detail=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('localhost', timeout=10)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Worker:
    def __init__(self, control):
        self.control = Path(control)

    def request(self, method='GET', path='/', data=None):
        connection = UnixConnection(self.control)
        try:
            connection.request(method, path, body=None if data is None else encoded(data),
                               headers={'Content-Type': 'application/json'})
            response = connection.getresponse()
            raw = response.read(MAX_BODY * 4 + 1)
            if len(raw) > MAX_BODY * 4:
                raise APIError(502, 'Worker response is too large.')
            value = json.loads(raw)
            if response.status >= 400:
                raise APIError(response.status, value.get('error', 'Worker rejected the request.'), value)
            return value
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise APIError(502, 'Cannot connect to Worker control socket.', str(error)) from error
        finally:
            connection.close()

    def identity(self):
        stat = self.control.stat()
        return stat.st_dev, stat.st_ino, stat.st_ctime_ns


class Dashboard:
    def __init__(self, worker, state_dir, name='Worker', interval=2, config_source='state'):
        self.worker = worker
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.name = name
        self.interval = interval
        self.config_source = config_source
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.samples = deque(maxlen=max(2, int(3600 / interval)))
        self.latest = None
        self.error = None
        self.last_success = None
        self.previous = None
        self.records_file = self.state_dir / 'changes.json'
        self.records = json.loads(self.records_file.read_text()) if self.records_file.exists() else []
        self.password_file = self.state_dir / 'admin-password'
        if not self.password_file.exists():
            fd = os.open(self.password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(secrets.token_urlsafe(18) + '\n')
        self.password = self.password_file.read_text().strip()
        if len(self.password) < 12:
            raise ValueError('The admin password must contain at least 12 characters.')
        self.sessions = {}
        self.failures = deque(maxlen=100)
        self.stop = threading.Event()

    def login(self, password):
        with self.lock:
            now = time.monotonic()
            while self.failures and self.failures[0] < now - 60:
                self.failures.popleft()
            if len(self.failures) >= 10:
                raise APIError(429, 'Too many attempts. Try again in one minute.')
            if not isinstance(password, str) or not hmac.compare_digest(password.encode(), self.password.encode()):
                self.failures.append(now)
                raise APIError(401, 'Invalid admin password.')
            self.sessions = {key: expires for key, expires in self.sessions.items() if expires > now}
            if len(self.sessions) >= 64:
                del self.sessions[next(iter(self.sessions))]
            token = secrets.token_urlsafe(32)
            self.sessions[token] = now + 12 * 3600
            return token

    def authenticated(self, token):
        with self.lock:
            return self.sessions.get(token, 0) > time.monotonic()

    def sample(self):
        with self.write_lock:
            self._sample()

    def _sample(self):
        timestamp = time.time()
        monotonic = time.monotonic()
        try:
            value = self.worker.request()
            identity = self.worker.identity()
            status = value['status']
            total = status['requests']['total']
            applications = status.get('applications', {})
            signatures = {name: application_revision(config)
                          for name, config in value['config'].get('applications', {}).items()}
            totals = {name: app.get('requests', {}).get('total')
                      for name, app in applications.items()}
            with self.lock:
                qps = None
                app_qps = {name: None for name in applications}
                if self.previous:
                    previous = self.previous
                    elapsed = monotonic - previous['time']
                    if identity == previous['identity'] and 0 < elapsed <= self.interval * 3:
                        unchanged = signatures == previous['signatures']
                        for name in applications:
                            if name in signatures and signatures[name] == previous['signatures'].get(name):
                                app_qps[name] = counter_rate(totals[name], previous['totals'].get(name), elapsed)
                            old_total = previous['totals'].get(name)
                            if (type(totals[name]) is int and type(old_total) is int
                                    and totals[name] < old_total):
                                unchanged = False
                        if unchanged:
                            qps = counter_rate(total, previous['total'], elapsed)
                sample = {key: deepcopy(status.get(key))
                          for key in ('processes', 'requests', 'responses', 'latency')}
                sample.update({'time': timestamp, 'qps': qps, 'total': total,
                               'applications': {name: {**deepcopy(app), 'qps': app_qps[name]}
                                                for name, app in applications.items()}})
                self.samples.append(sample)
                self.previous = {'total': total, 'time': monotonic, 'identity': identity,
                                 'signatures': signatures, 'totals': totals}
                self.latest = value
                self.error = None
                self.last_success = timestamp
        except (APIError, OSError, KeyError, TypeError) as error:
            with self.lock:
                self.samples.append({'time': timestamp, 'qps': None, 'total': None,
                                     'requests': None, 'processes': None, 'responses': None,
                                     'latency': None, 'applications': None})
                self.previous = None
                self.error = str(error)

    def collect(self):
        while not self.stop.is_set():
            self.sample()
            self.stop.wait(self.interval)

    def snapshot(self):
        with self.lock:
            latest = deepcopy(self.latest or {'config': {}, 'status': {}})
            return {**latest, 'instance': self.name, 'connected': self.latest is not None and self.error is None,
                    'error': self.error, 'last_success': self.last_success,
                    'revision': revision(latest['config']), 'interval': self.interval,
                    'config_source': self.config_source, 'samples': list(self.samples)}

    def history(self):
        with self.lock:
            return [{key: value for key, value in item.items() if key not in ('before', 'after')}
                    for item in reversed(self.records)]

    def record(self, record_id):
        with self.lock:
            for item in self.records:
                if item['id'] == record_id:
                    return deepcopy(item)
        raise APIError(404, 'Change record does not exist.')

    def change(self, operation, body):
        # Serializes dashboard writes. External control API writers still need
        # server-side conditional writes for a strict compare-and-swap guarantee.
        with self.write_lock:
            before = self.worker.request(path='/config')
            if body.get('revision') != revision(before):
                raise APIError(409, 'Configuration changed. Reload it before submitting again.')
            after = deepcopy(before)
            name = body.get('name')
            if operation in ('application', 'delete', 'restart'):
                if not isinstance(name, str) or not name or len(name) > 256:
                    raise APIError(400, 'An application name is required.')
            if operation == 'application':
                value = body.get('value')
                if not isinstance(value, dict):
                    raise APIError(400, 'Application configuration must be an object.')
                apps = after.setdefault('applications', {})
                if body.get('create') and name in apps:
                    raise APIError(409, 'An application with this name already exists.')
                apps[name] = value
            elif operation == 'delete':
                if name not in after.get('applications', {}):
                    raise APIError(404, 'Application does not exist.')
                del after['applications'][name]
            elif operation == 'configuration':
                after = body.get('value')
                if not isinstance(after, dict):
                    raise APIError(400, 'Configuration must be an object.')
            elif operation == 'restore':
                saved = self.record(body.get('id'))
                if saved['operation'] == 'restart':
                    raise APIError(400, 'A restart has no configuration to restore.')
                after = saved['before']
            elif operation == 'restart':
                if name not in before.get('applications', {}):
                    raise APIError(404, 'Application does not exist.')
            else:
                raise APIError(404, 'Unknown operation.')

            record = {'id': secrets.token_hex(8), 'time': time.time(), 'operation': operation,
                      'name': name, 'before': before, 'after': after, 'result': 'pending'}
            # Persist intent before changing Worker so an interrupted request is
            # visible and a local history write failure cannot silently lose it.
            with self.lock:
                records = (self.records + [record])[-100:]
                atomic_json(self.records_file, records)
                self.records = records
            error = None
            try:
                if operation == 'restart':
                    self.worker.request(path='/control/applications/' + quote(name, safe='') + '/restart')
                else:
                    self.worker.request('PUT', '/config', after)
                actual = self.worker.request(path='/config')
                record['result'] = 'success' if actual == after else 'changed'
            except APIError as failure:
                record['result'] = 'unknown' if failure.status == 502 else 'failed'
                record['error'] = {'message': failure.message, 'detail': failure.detail}
                error = failure
            with self.lock:
                atomic_json(self.records_file, self.records)
            if error:
                raise error
            with self.lock:
                if self.latest:
                    self.latest['config'] = deepcopy(actual)
            # Do not add a sample here: collector timing must remain independent
            # of the number of browsers and configuration operations.
            return {'config': actual, 'revision': revision(actual), 'record': record['id'],
                    'result': record['result']}


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, dashboard, hosts):
        self.dashboard = dashboard
        self.hosts = set(hosts)
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    server_version = 'WorkerDashboard/1'

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        LOG.info('%s %s', self.client_address[0], fmt % args)

    def send(self, status, value, content_type='application/json; charset=utf-8', cookie=None):
        data = encoded(value) if isinstance(value, (dict, list)) else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(data)

    def session(self):
        cookies = SimpleCookie()
        try:
            cookies.load(self.headers.get('Cookie', ''))
        except Exception:
            return ''
        return cookies['worker_session'].value if 'worker_session' in cookies else ''

    def cookie(self, token, age=43200):
        secure = '; Secure' if self.headers.get('X-Forwarded-Proto') == 'https' else ''
        return f'worker_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={age}{secure}'

    def body(self):
        if self.headers.get_content_type() != 'application/json':
            raise APIError(415, 'Expected application/json.')
        if self.headers.get('Transfer-Encoding'):
            raise APIError(400, 'Transfer-Encoding is unsupported.')
        try:
            size = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            raise APIError(400, 'Invalid Content-Length.')
        if size < 1 or size > MAX_BODY:
            raise APIError(413, 'Request must contain between 1 byte and 2 MiB.')
        try:
            value = json.loads(self.rfile.read(size), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (ValueError, UnicodeError):
            raise APIError(400, 'Invalid JSON.')
        if not isinstance(value, dict):
            raise APIError(400, 'Expected a JSON object.')
        return value

    def dispatch(self):
        host = self.headers.get('Host', '')
        try:
            hostname = urlsplit('http://' + host).hostname
        except ValueError:
            hostname = None
        if hostname not in self.server.hosts:
            raise APIError(403, 'Host is not allowed.')
        path = urlsplit(self.path).path
        app = self.server.dashboard
        if self.command == 'POST':
            if self.headers.get('Origin') not in ('http://' + host, 'https://' + host):
                raise APIError(403, 'Same-origin requests are required.')
            if self.headers.get('X-Worker-Request') != '1':
                raise APIError(403, 'Missing request header.')
        authenticated = app.authenticated(self.session())
        if path == '/api/session' and self.command == 'GET':
            return self.send(200, {'authenticated': authenticated, 'instance': app.name})
        if path == '/api/login' and self.command == 'POST':
            token = app.login(self.body().get('password'))
            return self.send(200, {'authenticated': True}, cookie=self.cookie(token))
        if path.startswith('/api/'):
            if not authenticated:
                raise APIError(401, 'Sign in to Worker.')
            if path == '/api/logout' and self.command == 'POST':
                with app.lock:
                    app.sessions.pop(self.session(), None)
                return self.send(200, {}, cookie=self.cookie('', 0))
            if self.command == 'GET':
                if path == '/api/state':
                    return self.send(200, app.snapshot())
                if path == '/api/config':
                    value = app.worker.request(path='/config')
                    return self.send(200, {'config': value, 'revision': revision(value)})
                if path == '/api/history':
                    return self.send(200, app.history())
                if path.startswith('/api/history/'):
                    return self.send(200, app.record(path.removeprefix('/api/history/')))
            if self.command == 'POST' and path.startswith('/api/change/'):
                return self.send(200, app.change(path.removeprefix('/api/change/'), self.body()))
            raise APIError(404, 'API endpoint does not exist.')
        if self.command not in ('GET', 'HEAD'):
            raise APIError(405, 'Method is not allowed.')
        assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                  '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                  '/charts.js': ('charts.js', 'text/javascript; charset=utf-8'),
                  '/style.css': ('style.css', 'text/css; charset=utf-8'),
                  '/icons.svg': ('icons.svg', 'image/svg+xml')}
        if path not in assets:
            raise APIError(404, 'Page does not exist.')
        filename, content_type = assets[path]
        self.send(200, (WEB / filename).read_bytes(), content_type)

    def handle_request(self):
        try:
            self.dispatch()
        except APIError as error:
            self.send(error.status, {'error': error.message, 'detail': error.detail})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except Exception:
            LOG.exception('Dashboard request failed')
            self.send(500, {'error': 'Dashboard request failed; check its server log.'})

    do_GET = handle_request
    do_HEAD = handle_request
    do_POST = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control', required=True, help='Worker filesystem control socket')
    parser.add_argument('--state', required=True, help='Private dashboard state directory')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=8090)
    parser.add_argument('--name', default='Worker')
    parser.add_argument('--allow-host', action='append', default=[])
    parser.add_argument('--config-source', default='state', help='state, or startup --config filename')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    app = Dashboard(Worker(args.control), args.state, args.name, config_source=args.config_source)
    server = Server((args.host, args.port), app, ['localhost', '127.0.0.1', args.host, *args.allow_host])
    collector = threading.Thread(target=app.collect, daemon=True)
    collector.start()
    LOG.info('Dashboard: http://%s:%s/; admin password file: %s', args.host, args.port, app.password_file)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.stop.set()
        server.server_close()
        collector.join(timeout=12)


if __name__ == '__main__':
    main()
