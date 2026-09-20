# Contributing

## Development Setup

The Dashboard uses Python 3.10+ and the Python standard library. No frontend
build or package installation is required.

Run the required tests from the repository root:

```sh
python3 -m unittest discover -s tests
```

Browser checks are optional and require Node.js, Playwright, a running
Dashboard, and a compatible Worker test asset directory. Their commands and
arguments are documented in `README.md`.

## Pull Requests

- Explain the user-visible behavior and security impact of the change.
- Add or update tests for behavior changes.
- Keep changes focused and avoid committing `.state/`, passwords, logs, or
  generated files.
- Update the documentation when command-line behavior or compatibility changes.

Before opening a pull request, run the required test suite and report any
optional checks that could not be run.
