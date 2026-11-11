"""Pinned Colab LoRA import and isolated, offline Chronos-2 close forecasts."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HOUR = 3_600_000
CONFIG = dict(lookback=256, pred_len=4, max_context=256, batch_size=1,
              sample_count=0, seed=42, temperature=0, top_k=0, top_p=0, clip=0)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def python_path():
    return ROOT / '.benchmark-envs' / 'chronos' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def rolling_installed_status(data_dir):
    live_root = Path(data_dir) / 'model-live/models/chronos2'
    current_path = live_root / 'current.json'
    try:
        if not current_path.is_file():
            raise FileNotFoundError('尚未完成本機 GPU Chronos-2 LoRA 首次訓練')
        current = json.loads(current_path.read_text(encoding='utf-8'))
        version_id = str(current.get('versionId') or '')
        if not version_id or '/' in version_id or '\\' in version_id or '..' in version_id:
            raise ValueError('Chronos-2 rolling versionId invalid')
        adapter_dir = (live_root / 'versions' / version_id / 'attempt' / 'adapter').resolve()
        adapter_dir.relative_to(live_root.resolve())
        sha_path = adapter_dir / 'adapter.sha256.json'
        if not sha_path.is_file():
            raise FileNotFoundError('Chronos-2 rolling adapter.sha256.json missing')
        inner = json.loads(sha_path.read_text(encoding='utf-8'))
        for name, expected in inner.items():
            target = (adapter_dir / name).resolve()
            target.relative_to(adapter_dir)
            if digest(target) != str(expected).lower():
                raise ValueError(f'Chronos rolling adapter hash mismatch: {name}')
        lock = json.loads((ROOT / 'research/model_benchmark/model-assets.lock.json').read_text(encoding='utf-8'))['models']['chronos2']
        if current.get('baseRevision') and str(current.get('baseRevision')) != str(lock['revision']):
            raise ValueError('Chronos base revision differs from lock')
        for name, expected in lock['files'].items():
            if digest(ROOT / '.benchmark-cache/models/chronos2' / name) != expected:
                raise ValueError('Chronos base hash mismatch')
        if not python_path().is_file():
            raise FileNotFoundError('Chronos Python environment missing')
        return dict(
            installed=True,
            source='local-rolling',
            repoId=lock['repo_id'],
            revision=lock['revision'],
            runId=version_id,
            versionId=version_id,
            adapterDir=str(adapter_dir),
            trainedAt=current.get('trainedAt'),
            cutoffTime=current.get('cutoffTime'),
            valReturnMae=current.get('valReturnMae'),
            nextRetrainAt=current.get('nextRetrainAt'),
            adapterSha256=inner.get('adapter_model.safetensors'),
        )
    except (OSError, ValueError, KeyError) as exc:
        return dict(installed=False, source='local-rolling', reason=str(exc))


def installed_status(data_dir):
    rolling = rolling_installed_status(data_dir)
    if rolling.get('installed'):
        return rolling
    folder = Path(data_dir) / 'model-research/models/chronos2'
    if not (folder / 'deployment.json').is_file():
        return rolling
    try:
        identity = json.loads((folder / 'deployment.json').read_text(encoding='utf-8'))
        lock = json.loads((ROOT / 'research/model_benchmark/model-assets.lock.json').read_text())['models']['chronos2']
        if identity['base'] != lock:
            raise ValueError('Chronos base identity differs from lock')
        for name, expected in identity['hashes'].items():
            p = (folder / name).resolve()
            p.relative_to(folder.resolve())
            if digest(p) != expected:
                raise ValueError('Chronos adapter hash mismatch')
        for name, expected in lock['files'].items():
            if digest(ROOT / '.benchmark-cache/models/chronos2' / name) != expected:
                raise ValueError('Chronos base hash mismatch')
        if not python_path().is_file():
            raise FileNotFoundError('Chronos Python environment missing')
        return dict(installed=True, source='legacy-deployment', repoId=lock['repo_id'], revision=lock['revision'],
                    runId=identity['runId'], adapterDir=str(folder / 'adapter'),
                    adapterSha256=identity['hashes']['adapter/adapter_model.safetensors'])
    except (OSError, ValueError, KeyError) as exc:
        return dict(installed=False, reason=str(exc))


def import_archive(archive, data_dir):
    """Import only hashed inference artifacts; never extract arbitrary ZIP paths."""
    target = Path(data_dir) / 'model-research/models/chronos2'
    if target.exists():
        raise FileExistsError(f'Refusing to overwrite {target}')
    with zipfile.ZipFile(archive) as z:
        manifests = [n for n in z.namelist() if n.count('/') == 1 and n.endswith('/run_manifest.json')]
        if len(manifests) != 1:
            raise ValueError('Expected one run manifest')
        m = json.loads(z.read(manifests[0]))
        saved = m['models']['chronos2']
        if m['status'] != 'SUCCESS' or saved['status'] != 'SUCCESS' or m.get('smoke'):
            raise ValueError('Expected successful full training run')
        run = manifests[0].split('/')[0]
        attempt = saved['attempt_dir'].replace('\\', '/').split('/' + run + '/')[-1]
        hashes = saved['artifact_hashes']
        required = ['adapter/adapter_config.json', 'adapter/adapter_model.safetensors']
        if any(n not in hashes for n in required):
            raise ValueError('Missing hashed adapter weights/config')
        blobs = {}
        for name in required:
            blob = z.read(run + '/' + attempt + '/' + name)
            if hashlib.sha256(blob).hexdigest() != hashes[name]:
                raise ValueError('Export adapter hash mismatch')
            blobs[name] = blob
        base = json.loads((ROOT / 'research/model_benchmark/model-assets.lock.json').read_text())['models']['chronos2']
        training = saved['training']
        if (training.get('model_id') != base['repo_id'] or training.get('revision') != base['revision']
                or training.get('weight_hashes') != base['files']):
            raise ValueError('Training base identity differs from pinned deployment base')
        cfg = json.loads(blobs[required[0]])
        if cfg.get('r') != 8:
            raise ValueError('Unexpected LoRA rank')
        # Base is pinned independently; the Colab-local path in PEFT config is not used.
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
            staging = Path(tmp) / 'deployment'
            for name, blob in blobs.items():
                p = staging / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(blob)
            (staging / 'deployment.json').write_text(json.dumps(dict(runId=m['run_id'], base=base,
                archiveSha256=digest(archive), hashes={n: hashes[n] for n in required}), indent=2), encoding='utf-8')
            staging.rename(target)
    return installed_status(data_dir)


def infer_candidates(df_1h, candidate_symbols, decision_open_time, data_dir, require_cuda=True, strict_rolling=True, **unused):
    from .kronos_runner import extract_256_window
    status = rolling_installed_status(data_dir) if strict_rolling else installed_status(data_dir)
    if not status['installed']:
        raise FileNotFoundError(status['reason'])
    windows, skipped = {}, []
    for symbol in list(dict.fromkeys(candidate_symbols))[:6]:
        w = extract_256_window(df_1h, symbol, decision_open_time)
        if w is None:
            skipped.append(dict(symbol=symbol, reason='連續 256 根已收盤 1h 資料不足'))
        else:
            windows[symbol] = w
    forecasts = {}
    started = time.perf_counter()
    if windows:
        req = dict(
            dataDir=str(data_dir),
            adapterDir=status.get('adapterDir'),
            requireCuda=bool(require_cuda),
            contexts=[w.close.tolist() for w in windows.values()],
        )
        env = dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', MPLBACKEND='Agg')
        # Inherit stderr and the worker process group so collector termination also kills this child.
        proc = subprocess.run([str(python_path()), '-m', 'research.model_research.chronos_runner', 'predict'],
            cwd=ROOT, input=json.dumps(req), stdout=subprocess.PIPE, text=True, env=env, timeout=480)
        if proc.returncode:
            raise RuntimeError('Chronos-2 inference failed; see worker log')
        response = json.loads(proc.stdout)
        predictions = response['predictions']
        if len(predictions) != len(windows):
            raise ValueError('Chronos returned wrong batch length')
        import math
        for (symbol, w), values in zip(windows.items(), predictions):
            if len(values) != 4 or any(not math.isfinite(v) or v <= 0 for v in values):
                raise ValueError('Invalid Chronos close forecast')
            last = float(w.close.iloc[-1])
            history = [dict(openTime=int(r.open_time), closeTime=int(r.open_time)+HOUR-1,
                time=int(r.open_time)//1000, **{k: float(r[k]) for k in ['open','high','low','close','volume']})
                for _, r in w.tail(64).iterrows()]
            closes = [dict(step=i+1, openTime=int(decision_open_time)+(i+1)*HOUR,
                closeTime=int(decision_open_time)+(i+2)*HOUR-1, close=float(v)) for i,v in enumerate(values)]
            forecasts[symbol] = dict(symbol=symbol, modelKey='chronos2', repoId=status['repoId'],
                revision=status['revision'], cutoffTime=int(decision_open_time)+HOUR, lastOpenTime=int(decision_open_time),
                lastClosePrice=last, predictedClose4h=values[-1], predictedReturn4h=values[-1]/last-1,
                trainingRunId=status['runId'], adapterSha256=status['adapterSha256'],
                forecastType='close', predictedCloses=closes, predictedCandles=[], historicalCandles=history,
                elapsedMs=response['elapsedMs']/len(windows), peakVramAllocatedMb=response['peakMb'],
                peakVramReservedMb=response['reservedMb'], inferenceConfig=CONFIG,
                dispersionDisclaimer='Chronos-2 微調模型之收盤價中位數預測，未提供校準信賴區間。')
    return dict(forecasts=forecasts, skippedSymbols=skipped, targetSymbols=list(windows),
        modelInfo=dict(repoId=status['repoId'], revision=status['revision'], modelSha256=status['adapterSha256'],
            tokenizerRepoId='', tokenizerRevision='', tokenizerSha256=None), gpuEnv={},
        totalElapsedMs=(time.perf_counter()-started)*1000, peakVramAllocatedMb=max([f['peakVramAllocatedMb'] for f in forecasts.values()] or [0]),
        peakVramReservedMb=max([f['peakVramReservedMb'] for f in forecasts.values()] or [0]))


def main():
    if sys.argv[1] == 'import':
        print(json.dumps(import_archive(Path(sys.argv[2]), Path(sys.argv[3])), ensure_ascii=False))
        return
    req = json.loads(sys.stdin.read())
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        from peft import PeftModel
        from research.model_benchmark.ts_adapters import _base_model, _prediction_mean
        status = installed_status(req['dataDir'])
        if not status['installed']:
            raise FileNotFoundError(status['reason'])
        require_cuda = bool(req.get('requireCuda', True))
        if require_cuda and not torch.cuda.is_available():
            raise RuntimeError('CUDA GPU 不可用；Chronos-2 推論必須使用本機 GPU')
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        adapter_dir = Path(req['adapterDir']) if req.get('adapterDir') else Path(status['adapterDir'])
        started = time.perf_counter()
        torch.manual_seed(42)
        model = PeftModel.from_pretrained(_base_model('chronos2', device),
            adapter_dir, is_trainable=False).to(device=device, dtype=torch.float32)
        rows = [np.asarray(c, dtype=np.float32) for c in req['contexts']]
        if any(c.shape != (256,) or not np.all(np.isfinite(c)) or np.any(c <= 0) for c in rows):
            raise ValueError('Invalid Chronos context')
        values = _prediction_mean('chronos2', model, rows, device)
        result = dict(predictions=values.tolist(), elapsedMs=(time.perf_counter()-started)*1000,
            peakMb=torch.cuda.max_memory_allocated()/2**20 if device=='cuda' else 0,
            reservedMb=torch.cuda.max_memory_reserved()/2**20 if device=='cuda' else 0)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
