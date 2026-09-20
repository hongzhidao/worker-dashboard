"""Two ASGI entry points sharing one Worker application process pool."""
import asyncio
import json
import os
import time
from urllib.parse import parse_qs


async def respond(scope, receive, send, entry):
    if scope['type'] == 'lifespan':
        while True:
            message = await receive()
            if message['type'] == 'lifespan.startup':
                await send({'type': 'lifespan.startup.complete'})
            elif message['type'] == 'lifespan.shutdown':
                await send({'type': 'lifespan.shutdown.complete'})
                return
    if scope['type'] != 'http':
        return
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            return
        if not message.get('more_body', False):
            break
    try:
        number = int(parse_qs(scope.get('query_string', b'').decode()).get('n', ['1'])[0])
    except ValueError:
        number = 1
    delay = (12 + number % 39 + (90 if number % 17 == 0 else 0)) / 1000
    await asyncio.sleep(delay)
    route = scope.get('path', '/')
    status = {'/missing': 404, '/unavailable': 503, '/redirect': 302}.get(route, 200)
    body = json.dumps({'demo': True, 'application': 'demo-api', 'entry': entry,
                       'pid': os.getpid(), 'path': route, 'time': time.time(),
                       'items': [{'id': 'item-1', 'name': 'Notebook'},
                                 {'id': 'item-2', 'name': 'Pencil'}] if status == 200 else [],
                       'status': status}).encode()
    headers = [(b'content-type', b'application/json'), (b'content-length', str(len(body)).encode())]
    if status == 302:
        headers.append((b'location', b'/catalog'))
    await send({'type': 'http.response.start', 'status': status, 'headers': headers})
    await send({'type': 'http.response.body', 'body': body})


async def application(scope, receive, send):
    await respond(scope, receive, send, 'public')


async def admin(scope, receive, send):
    await respond(scope, receive, send, 'admin')
