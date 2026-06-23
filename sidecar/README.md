# loqui-sidecar

The Loqui Python sidecar: a FastAPI + WebSocket service that does all ML/audio-heavy
work for the desktop app. It is spawned and supervised by the Electron main process.

## Contract

- Binds to **127.0.0.1** on an **ephemeral port** and prints a single handshake line
  to stdout as JSON **before** it begins serving:

  ```json
  {"port": 51234, "token": "<random>", "protocolVersion": "0.1.0"}
  ```

  The main process reads exactly that line, then connects to
  `ws://127.0.0.1:<port>` and presents `<token>` on every WS/HTTP request.
- `GET /health` returns `{status, version, protocolVersion, models}`.
- WS control protocol: `ping`/`pong`, `getHealth`, `shutdown` (see the shared
  contract; JSON Schemas are emitted to `packages/shared/schema/*.json` and the
  sidecar validates incoming frames against them).
- `protocolVersion` MUST match the desktop app's `PROTOCOL_VERSION`; the handshake
  fails loudly on mismatch.
- Graceful shutdown on SIGTERM and on parent-exit detection.

## Develop

```sh
uv sync                 # create the venv + install deps (Python 3.12)
uv run loqui-sidecar    # start the sidecar (prints the handshake line)
uv run pytest           # run tests
```

The implementation of the server, handshake, and validation lands in the Build phase.
This scaffold provides the package skeleton + entrypoint only.
