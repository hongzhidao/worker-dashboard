from copy import deepcopy
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from server import APIError, Dashboard, Server, revision


class FakeWorker:
    def __init__(self):
        self.config = {'applications': {'api': {'type': 'python', 'listen': '127.0.0.1:8080',
                                               'module': 'wsgi', 'environment': {'SECRET': 'keep'}}}}
        metrics = {'processes': {'running': 2, 'idle': 1, 'starting': 0, 'stopping': 0},
                   'requests': {'total': 10, 'waiting': 0, 'processing': 1, 'completed': 9},
                   'responses': {'1xx': 0, '2xx': 8, '3xx': 0, '4xx': 0, '5xx': 1},
                   'latency': {'p50': 8, 'p95': 24, 'p99': 24}}
        self.status = {**deepcopy(metrics), 'applications': {'api': deepcopy(metrics)}}
        self.ident = (1, 2, 3)
        self.disconnected = False
        self.writes = []

    def identity(self):
        return self.ident

    def request(self, method='GET', path='/', data=None):
        if self.disconnected:
            raise APIError(502, 'Disconnected')
        if method == 'PUT':
            self.writes.append((method, path, deepcopy(data)))
            if data.get('invalid'):
                raise APIError(400, 'Invalid configuration', {'detail': 'Unknown parameter'})
            self.config = deepcopy(data)
            return {'success': 'Reconfiguration done.'}
        if path == '/config':
            return deepcopy(self.config)
        if path.startswith('/control/'):
            self.writes.append((method, path, None))
            return {'success': 'Ok'}
        return deepcopy({'config': self.config, 'status': self.status})


class DashboardFixture(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.worker = FakeWorker()
        self.app = Dashboard(self.worker, self.directory.name)


class DashboardTests(DashboardFixture):
    def test_complete_metrics_and_application_rates(self):
        self.worker.status['latency']['p95'] = 48
        with patch('server.time.monotonic', side_effect=[10, 12]):
            self.app.sample()
            self.worker.status['requests']['total'] = 30
            self.worker.status['applications']['api']['requests']['total'] = 30
            self.app.sample()
        sample = self.app.samples[-1]
        self.assertEqual(sample['qps'], 10)
        self.assertEqual(sample['applications']['api']['qps'], 10)
        self.assertEqual(sample['latency']['p95'], 48)
        self.assertEqual(sample['applications']['api']['latency']['p95'], 24)
        self.assertEqual(sample['requests']['waiting'], 0)
        self.assertEqual(sample['responses']['5xx'], 1)
        self.assertNotIn('qps', self.worker.status['applications']['api'])
        self.worker.status['latency']['p95'] = None
        self.assertEqual(sample['latency']['p95'], 48)

    def test_replacement_reset_and_listener_changes(self):
        with patch('server.time.monotonic', side_effect=[10, 12, 14, 16, 18]):
            self.app.sample()
            self.worker.config['applications']['api']['module'] = 'new_module'
            self.worker.status['requests']['total'] = 100
            self.worker.status['applications']['api']['requests']['total'] = 100
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.assertIsNone(self.app.samples[-1]['applications']['api']['qps'])
            self.worker.config['applications']['api']['listen'] = '127.0.0.1:8081'
            self.worker.status['requests']['total'] = 110
            self.worker.status['applications']['api']['requests']['total'] = 110
            self.app.sample()
            self.assertEqual(self.app.samples[-1]['qps'], 5)
            self.assertEqual(self.app.samples[-1]['applications']['api']['qps'], 5)
            # A per-app reset invalidates the global rate even if other traffic
            # makes the total increase over this sampling interval.
            self.worker.status['requests']['total'] = 120
            self.worker.status['applications']['api']['requests']['total'] = 1
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.assertIsNone(self.app.samples[-1]['applications']['api']['qps'])
            del self.worker.config['applications']['api']
            del self.worker.status['applications']['api']
            self.worker.status['requests']['total'] = 130
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])

    def test_unrelated_application_rate_survives_membership_change(self):
        with patch('server.time.monotonic', side_effect=[10, 12, 14]):
            self.app.sample()
            self.worker.config['applications']['other'] = {'type': 'python', 'module': 'other'}
            self.worker.status['applications']['other'] = deepcopy(self.worker.status['applications']['api'])
            self.worker.status['applications']['api']['requests']['total'] = 20
            self.worker.status['requests']['total'] = 30
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.assertIsNone(self.app.samples[-1]['applications']['other']['qps'])
            self.assertEqual(self.app.samples[-1]['applications']['api']['qps'], 5)
            self.worker.status['latency'] = {'p50': None, 'p95': None, 'p99': None}
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['latency']['p95'])

    def test_sample_rate_reset_and_connection_gap(self):
        with patch('server.time.monotonic', side_effect=[10, 12, 14, 16, 18, 20, 22]):
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.worker.status['requests']['total'] = 20
            self.app.sample()
            self.assertEqual(self.app.samples[-1]['qps'], 5)
            self.worker.disconnected = True
            self.app.sample()
            snapshot = self.app.snapshot()
            self.assertFalse(snapshot['connected'])
            self.assertIsNone(snapshot['samples'][-1]['applications'])
            self.assertEqual(snapshot['status']['requests']['total'], 20)
            self.worker.disconnected = False
            self.worker.status['requests']['total'] = 40
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.worker.status['requests']['total'] = 5
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.worker.status['requests']['total'] = 80
            self.worker.ident = (1, 2, 4)
            self.app.sample()
            self.assertIsNone(self.app.samples[-1]['qps'])
            self.app.sample()
            self.assertEqual(self.app.samples[-1]['qps'], 0)

    def test_conflict_does_not_write_or_lose_external_change(self):
        base = revision(self.worker.config)
        self.worker.config['settings'] = {'http': {'send_timeout': 60}}
        with self.assertRaises(APIError) as context:
            self.app.change('delete', {'name': 'api', 'revision': base})
        self.assertEqual(context.exception.status, 409)
        self.assertFalse(self.worker.writes)
        self.assertEqual(self.worker.config['settings']['http']['send_timeout'], 60)

    def test_application_edit_preserves_other_config_and_restores(self):
        self.worker.config['settings'] = {'http': {'send_timeout': 60}}
        original = deepcopy(self.worker.config)
        value = deepcopy(original['applications']['api'])
        value['processes'] = 4
        self.app.sample()
        response = self.app.change('application', {'name': 'api', 'value': value,
                                                   'revision': revision(original)})
        self.assertEqual(self.worker.config['settings'], original['settings'])
        self.assertEqual(self.worker.config['applications']['api']['environment'], {'SECRET': 'keep'})
        self.assertEqual(self.app.snapshot()['config'], self.worker.config)
        history = self.app.history()
        self.assertNotIn('before', history[0])
        self.assertNotIn('after', history[0])
        self.assertEqual(history[0]['result'], 'success')
        self.app.change('restore', {'id': response['record'], 'revision': revision(self.worker.config)})
        self.assertEqual(self.worker.config, original)
        restored = Dashboard(self.worker, self.directory.name)
        self.assertEqual(len(restored.history()), 2)
        self.assertEqual(Path(self.directory.name, 'changes.json').stat().st_mode & 0o777, 0o600)

    def test_rejected_config_is_recorded_and_previous_config_survives(self):
        original = deepcopy(self.worker.config)
        with self.assertRaises(APIError):
            self.app.change('configuration', {'value': {'invalid': True}, 'revision': revision(original)})
        self.assertEqual(self.worker.config, original)
        self.assertEqual(self.app.history()[0]['result'], 'failed')
        self.assertEqual(self.app.record(self.app.history()[0]['id'])['before'], original)

    def test_restart_maps_to_control_get_without_config_write(self):
        self.app.change('restart', {'name': 'api', 'revision': revision(self.worker.config)})
        self.assertEqual(self.worker.writes, [('GET', '/control/applications/api/restart', None)])

    def test_create_duplicate_rejected(self):
        with self.assertRaises(APIError) as context:
            self.app.change('application', {'name': 'api', 'value': {}, 'create': True,
                                           'revision': revision(self.worker.config)})
        self.assertEqual(context.exception.status, 409)
        self.assertFalse(self.worker.writes)

    def test_audit_failure_prevents_worker_write(self):
        with patch('server.atomic_json', side_effect=OSError('Disk full')):
            with self.assertRaises(OSError):
                self.app.change('delete', {'name': 'api', 'revision': revision(self.worker.config)})
        self.assertFalse(self.worker.writes)

    def test_rate_limit_and_password_file(self):
        self.assertEqual(self.app.password_file.stat().st_mode & 0o777, 0o600)
        for _ in range(10):
            with self.assertRaises(APIError):
                self.app.login('wrong')
        with self.assertRaises(APIError) as context:
            self.app.login(self.app.password)
        self.assertEqual(context.exception.status, 429)


class HTTPTests(DashboardFixture):
    def setUp(self):
        super().setUp()
        self.server = Server(('127.0.0.1', 0), self.app, ['127.0.0.1'])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.finish)

    def finish(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, cookie=None, origin=True, host=None):
        connection = http.client.HTTPConnection(*self.server.server_address)
        headers = {}
        if body is not None:
            headers.update({'Content-Type': 'application/json', 'X-Worker-Request': '1'})
            if origin:
                headers['Origin'] = 'http://127.0.0.1:' + str(self.server.server_port)
        if cookie:
            headers['Cookie'] = cookie
        if host:
            headers['Host'] = host
        connection.request('POST' if body is not None else 'GET', path,
                           body=json.dumps(body) if body is not None else None, headers=headers)
        response = connection.getresponse()
        data = response.read()
        cookie = response.getheader('Set-Cookie')
        status = response.status
        connection.close()
        return status, data, cookie

    def test_auth_origin_host_and_logout(self):
        self.assertEqual(self.request('/api/state')[0], 401)
        self.assertEqual(self.request('/api/login', {'password': self.app.password}, origin=False)[0], 403)
        self.assertEqual(self.request('/api/session', host='evil.example')[0], 403)
        status, _, cookie = self.request('/api/login', {'password': self.app.password})
        self.assertEqual(status, 200)
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Strict', cookie)
        self.assertEqual(self.request('/api/state', cookie=cookie)[0], 200)
        self.assertEqual(self.request('/api/change/delete', {'name': 'api'}, cookie=cookie, origin=False)[0], 403)
        self.assertEqual(self.request('/api/logout', {}, cookie=cookie)[0], 200)
        self.assertEqual(self.request('/api/state', cookie=cookie)[0], 401)

    def test_static_allowlist_and_initial_state(self):
        self.assertEqual(self.request('/')[0], 200)
        self.assertEqual(self.request('/../server.py')[0], 404)
        self.assertEqual(self.request('/admin-password')[0], 404)
        self.assertFalse(self.app.snapshot()['connected'])


if __name__ == '__main__':
    unittest.main()
