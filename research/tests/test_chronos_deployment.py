import hashlib
import json
import zipfile

import pytest

from research.model_research import chronos_runner as cr


def archive(tmp_path, monkeypatch, *, corrupt=False, revision='pinned'):
    root = tmp_path / 'repo'
    lock = root / 'research/model_benchmark/model-assets.lock.json'
    lock.parent.mkdir(parents=True)
    base = dict(repo_id='amazon/chronos-2', revision='pinned', files={'model.safetensors': 'basehash'})
    lock.write_text(json.dumps({'models': {'chronos2': base}}))
    monkeypatch.setattr(cr, 'ROOT', root)
    blobs = {'adapter/adapter_config.json': b'{"r": 8}', 'adapter/adapter_model.safetensors': b'weights'}
    hashes = {n: hashlib.sha256(b).hexdigest() for n, b in blobs.items()}
    m = dict(status='SUCCESS', run_id='run-test', models={'chronos2': dict(status='SUCCESS',
        attempt_dir='/content/runs/run-test/models/chronos2/attempt', artifact_hashes=hashes,
        training=dict(model_id=base['repo_id'], revision=revision, weight_hashes=base['files']))})
    p = tmp_path / 'export.zip'
    with zipfile.ZipFile(p, 'w') as z:
        z.writestr('run-test/run_manifest.json', json.dumps(m))
        for name, blob in blobs.items():
            z.writestr('run-test/models/chronos2/attempt/' + name, blob + (b'bad' if corrupt else b''))
    return p


def test_reject_corrupt_adapter_without_creating_deployment(tmp_path, monkeypatch):
    p = archive(tmp_path, monkeypatch, corrupt=True)
    with pytest.raises(ValueError, match='hash mismatch'):
        cr.import_archive(p, tmp_path / 'data')
    assert not (tmp_path / 'data/model-research/models/chronos2').exists()


def test_reject_different_training_base(tmp_path, monkeypatch):
    p = archive(tmp_path, monkeypatch, revision='other')
    with pytest.raises(ValueError, match='base identity'):
        cr.import_archive(p, tmp_path / 'data')


def test_preserve_existing_deployment(tmp_path, monkeypatch):
    p = archive(tmp_path, monkeypatch)
    data = tmp_path / 'data'
    cr.import_archive(p, data)
    deployed = data / 'model-research/models/chronos2'
    assert (deployed / 'adapter/adapter_model.safetensors').read_bytes() == b'weights'
    assert not cr.installed_status(data)['installed']  # base assets not available
    with pytest.raises(FileExistsError):
        cr.import_archive(p, data)
