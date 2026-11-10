from __future__ import annotations

import json
import io
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from research.model_benchmark.colab import (
    TRAINING_PYTHON_ENV,
    python_executable,
    run_with_snapshots,
    training_python,
    verify_torch_environments,
)


def test_training_python_probe_uses_isolated_mode(tmp_path: Path) -> None:
    python = tmp_path / "managed-python"
    python.write_bytes(b"test interpreter placeholder")
    result = SimpleNamespace(
        returncode=0,
        stdout=json.dumps({"version": [3, 12], "executable": str(python)}),
        stderr="",
    )
    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=result) as run:
        assert training_python({TRAINING_PYTHON_ENV: str(python)}) == python.resolve()
    command = run.call_args.args[0]
    assert command[1] == "-I"
    assert "-c" in command
    assert "env" not in run.call_args.kwargs  # non-Python CUDA/SSL variables remain inherited


def test_torch_environment_probes_use_isolated_mode_and_keep_cuda_environment(tmp_path: Path) -> None:
    env_root = tmp_path / "envs"
    for name in ("chronos", "timesfm"):
        python = python_executable(env_root, name)
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_bytes(b"test interpreter placeholder")
    result = SimpleNamespace(
        returncode=0,
        stdout=json.dumps({
            "torch": "2.6.0+cu126", "cuda": "12.6", "available": True,
            "gpu": "NVIDIA A100", "memory_bytes": 40 * 1024**3,
        }),
        stderr="",
    )
    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=result) as run:
        info = verify_torch_environments(env_root, require_a100=True)
    assert set(info) == {"chronos", "timesfm"}
    assert len(run.call_args_list) == 2
    assert all(call.args[0][1] == "-I" for call in run.call_args_list)
    assert all("env" not in call.kwargs for call in run.call_args_list)


def test_runner_uses_rank_venv_entrypoint_and_keeps_managed_python_for_bootstrap(tmp_path: Path) -> None:
    env_root = tmp_path / "envs"
    rank_python = python_executable(env_root, "rank")
    rank_python.parent.mkdir(parents=True, exist_ok=True)
    rank_python.write_bytes(b"rank venv python with model dependencies")
    managed_python = tmp_path / "managed" / "python"
    managed_python.parent.mkdir(parents=True)
    managed_python.write_bytes(b"managed Python base without model dependencies")
    env = {
        "FADACHI_MODEL_BENCHMARK_ENV_ROOT": str(env_root),
        TRAINING_PYTHON_ENV: str(managed_python),
    }
    version_probe = SimpleNamespace(
        returncode=0,
        stdout=json.dumps({"version": [3, 12]}),
        stderr="",
    )

    class FinishedProcess:
        def __init__(self, _command, **_kwargs):
            self.stdout = io.StringIO("toy runner finished\n")

        @staticmethod
        def wait():
            return 0

    command = ["kernel-python", "-u", "-m", "research.model_benchmark.runner", "--smoke"]
    captured_env: dict[str, str] = {}

    def popen(command, **kwargs):
        captured_env.update(kwargs["env"])
        return FinishedProcess(command, **kwargs)

    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=version_probe) as probe, \
         mock.patch("research.model_benchmark.colab.subprocess.Popen", side_effect=popen) as child:
        result = run_with_snapshots(
            command,
            repo_root=tmp_path,
            env=env,
            run_root=tmp_path / "run",
            store=object(),
            log_path=tmp_path / "logs" / "runner.log",
        )

    runner_command = child.call_args.args[0]
    assert runner_command[0] == str(rank_python)  # retain venv script path; never resolve to its base symlink
    assert runner_command[0] != str(managed_python)
    assert captured_env[TRAINING_PYTHON_ENV] == str(managed_python.resolve())
    assert [call.args[0][0] for call in probe.call_args_list] == [str(managed_python.resolve()), str(rank_python)]
    assert result["return_code"] == 0
