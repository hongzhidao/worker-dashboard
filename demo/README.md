# Live dashboard demonstration

These applications serve real HTTP requests through Worker. Their product/report
payloads are illustrative; request, response, process, and latency statistics are
measured by Worker. Nothing writes fabricated statistics into the dashboard.

```sh
python3 demo/run.py start
python3 demo/run.py status
python3 demo/run.py stop
```

The default run lasts up to 30 minutes, with eight local HTTP clients. Use
`--duration SECONDS` to choose a duration up to one hour. Requests vary over time
and include successful, redirect, missing-resource, and controlled failure paths.

- `demo-api`: Python ASGI, two targets (`public` and `admin`) sharing two processes.
- `demo-store`: PHP, an on-demand process pool with one spare and up to three workers.
- `demo-reports`: Python WSGI, a single process with slower responses that make
  waiting and processing requests visible.

The runner uses the existing dashboard at `127.0.0.1:8090`, authenticates using
`.state/admin-password`, and records app creation in dashboard
history. Existing applications are retained. Names already used by unrelated
applications receive a numeric suffix. Repeated starts reuse marked demo apps
without replacing their configuration.

All traffic stays on loopback addresses. The runner checks the configuration
every five seconds, follows local listener changes, and skips removed apps or
apps whose `WORKER_DASHBOARD_DEMO` marker was removed. Preferred ports are
18100–18103; available alternatives are selected if these ports are occupied.

The private run state and observed response counts are stored under
`.state/demo`. Stopping traffic leaves the applications available for
editing; they can be deleted through the dashboard. Pass `--worker-log /path/to/worker.log` to stop the run after that debug log
grows by 512 MiB. `status` reports the stop
reason. This is demonstration traffic, not a throughput benchmark.
