"""Unit tests for the frozen ``-m`` dispatch in :mod:`loqui_sidecar.__main__`.

PACKAGED-APP CRASH-SAFETY: the sidecar ships as a PyInstaller frozen binary
whose ``sys.executable`` is NOT a real python and does not implement ``-m``.
:mod:`loqui_sidecar.postprocess.sherpa_backend` isolates diarization by spawning
``[sys.executable, "-m", <worker>, payload]``, so ``__main__.main`` must EMULATE
``-m``: route the allowlisted worker to its ``main`` (returning its exit code),
error out for any unknown module, and NEVER boot the server for a ``-m`` launch.
The plain (no-arg) launch must still run the server unchanged.

Hermetic: ``server.run`` and ``sherpa_worker.main`` are mocked — no port is
bound and no ONNX runtime is touched.
"""

from __future__ import annotations

import sys

import pytest

from loqui_sidecar import __main__ as entry


def _set_argv(monkeypatch, argv: list[str]) -> None:
    monkeypatch.setattr(sys, "argv", argv)


def test_no_args_runs_the_server(monkeypatch):
    """The plain launch (no ``-m``) still calls server.run() and returns its code."""
    calls = []
    monkeypatch.setattr(entry, "run", lambda: calls.append(True) or 0)
    _set_argv(monkeypatch, ["loqui-sidecar"])
    assert entry.main() == 0
    assert calls == [True]


def test_server_flags_still_run_the_server(monkeypatch):
    """Non-``-m`` argv (e.g. --no-watch-stdin) falls through to run(), not dispatch.

    run() parses argv itself; main() must not intercept server flags.
    """
    calls = []
    monkeypatch.setattr(entry, "run", lambda: calls.append(True) or 0)
    _set_argv(monkeypatch, ["loqui-sidecar", "--no-watch-stdin", "--parent-pid", "123"])
    assert entry.main() == 0
    assert calls == [True]


def test_dash_m_routes_to_worker_main_with_payload_argv(monkeypatch):
    """``-m <worker> <payload>`` calls sherpa_worker.main(["<worker>", "<payload>"])
    and returns its exit code — the argv shape main() expects (payload at [1])."""
    from loqui_sidecar.postprocess import sherpa_worker

    seen = {}

    def _fake_worker_main(argv):
        seen["argv"] = argv
        return 7

    monkeypatch.setattr(sherpa_worker, "main", _fake_worker_main)
    # server.run must never be reached on the -m path.
    monkeypatch.setattr(entry, "run", lambda: pytest.fail("server.run must not run on -m"))

    payload = '{"segmentation": "s.onnx", "wav": "a.wav"}'
    _set_argv(monkeypatch, ["loqui-sidecar", "-m", entry._WORKER_MODULE, payload])
    rc = entry.main()

    assert rc == 7
    assert seen["argv"] == [entry._WORKER_MODULE, payload]


def test_dash_m_worker_forwards_extra_args(monkeypatch):
    """Extra module args are forwarded after the module name (argv[2:])."""
    from loqui_sidecar.postprocess import sherpa_worker

    seen = {}

    def _fake_worker_main(argv):
        seen["argv"] = argv
        return 0

    monkeypatch.setattr(sherpa_worker, "main", _fake_worker_main)
    monkeypatch.setattr(entry, "run", lambda: pytest.fail("server.run must not run on -m"))
    _set_argv(monkeypatch, ["loqui-sidecar", "-m", entry._WORKER_MODULE, "p1", "p2"])
    assert entry.main() == 0
    assert seen["argv"] == [entry._WORKER_MODULE, "p1", "p2"]


def test_dash_m_unknown_module_errors_and_never_runs_server(monkeypatch, capsys):
    """An unknown ``-m`` target exits non-zero and NEVER boots the server."""
    monkeypatch.setattr(entry, "run", lambda: pytest.fail("server.run must not run on unknown -m"))
    _set_argv(monkeypatch, ["loqui-sidecar", "-m", "os", "-c", "print(1)"])
    rc = entry.main()
    assert rc != 0
    err = capsys.readouterr().err
    assert "unknown -m module" in err
    assert "'os'" in err


def test_dash_m_without_module_errors(monkeypatch, capsys):
    """``-m`` with no module name errors out (never runs the server)."""
    monkeypatch.setattr(entry, "run", lambda: pytest.fail("server.run must not run"))
    _set_argv(monkeypatch, ["loqui-sidecar", "-m"])
    rc = entry.main()
    assert rc != 0
    assert "requires a module name" in capsys.readouterr().err


def test_main_calls_freeze_support(monkeypatch):
    """freeze_support() is invoked (required in the frozen app, harmless in dev)."""
    called = []
    monkeypatch.setattr(entry.multiprocessing, "freeze_support", lambda: called.append(True))
    monkeypatch.setattr(entry, "run", lambda: 0)
    _set_argv(monkeypatch, ["loqui-sidecar"])
    assert entry.main() == 0
    assert called == [True]
