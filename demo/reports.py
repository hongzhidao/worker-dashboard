"""A deliberately slower WSGI report endpoint for observing request queues."""
import json
import os
import time
from urllib.parse import parse_qs


def application(environ, start_response):
    try:
        number = int(parse_qs(environ.get('QUERY_STRING', '')).get('n', ['1'])[0])
    except ValueError:
        number = 1
    time.sleep((260 + number % 401) / 1000)
    route = environ.get('PATH_INFO', '/')
    status = {'/missing': '404 Not Found', '/unavailable': '503 Service Unavailable',
              '/redirect': '302 Found'}.get(route, '200 OK')
    body = json.dumps({'demo': True, 'application': 'demo-reports', 'pid': os.getpid(),
                       'path': route, 'time': time.time(), 'status': int(status[:3]),
                       'rows': sum(range(100)) if status.startswith('200') else 0}).encode()
    headers = [('Content-Type', 'application/json'), ('Content-Length', str(len(body)))]
    if status.startswith('302'):
        headers.append(('Location', '/daily'))
    start_response(status, headers)
    return [body]
