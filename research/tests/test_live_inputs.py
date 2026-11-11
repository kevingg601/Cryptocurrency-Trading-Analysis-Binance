import pandas as pd
import pytest

from research.model_research import live_inputs as live

HOUR = live.ONE_HOUR_MS


def fake_bars(symbol, start, end):
    return pd.DataFrame([dict(symbol=symbol, open_time=t, close_time=t+HOUR-1,
        open=100., high=102., low=99., close=101., volume=10., quote_volume=1010., is_final=True)
        for t in range(start, end, HOUR)])


def fake_rates(symbol, start, end):
    return pd.DataFrame([dict(symbol=symbol, funding_time=end-8*HOUR, funding_rate=.0001),
                         dict(symbol=symbol, funding_time=end+1, funding_rate=.9)])


def setup(monkeypatch):
    monkeypatch.setattr(live, 'fetch_binance_1h_klines_for_symbol', fake_bars)
    monkeypatch.setattr(live, 'fetch_binance_funding_rates_for_symbol', fake_rates)
    return dict(datasetVersion='original', universe=dict(symbols=[f'COIN{i}USDT' for i in range(10)]))


def test_latest_closed_hour_and_immutable_training_inputs(tmp_path, monkeypatch):
    manifest = setup(monkeypatch)
    original = tmp_path/'model-research/datasets/klines_1h.parquet'
    original.parent.mkdir(parents=True)
    original.write_bytes(b'original-training-data')
    bars, rates, path, result, cutoff = live.refresh_inputs(tmp_path, 'run-new', manifest, 400*HOUR+12345)
    assert cutoff == 400*HOUR
    assert bars.open_time.max() == 399*HOUR
    assert rates.funding_time.max() <= cutoff
    assert original.read_bytes() == b'original-training-data'
    assert path != original and path.exists()
    assert manifest['datasetVersion'] == 'original'
    assert result['trainingDatasetVersion'] == 'original'


def test_stale_data_does_not_fall_back_or_publish(tmp_path, monkeypatch):
    manifest = setup(monkeypatch)
    monkeypatch.setattr(live, 'fetch_binance_1h_klines_for_symbol', lambda s,a,b: fake_bars(s,a,b-HOUR))
    with pytest.raises(ValueError, match='最新已收盤'):
        live.refresh_inputs(tmp_path, 'run-stale', manifest, 400*HOUR)
    assert not (tmp_path/'model-research/live-inputs/run-stale').exists()


def test_window_gap_rejected(tmp_path, monkeypatch):
    manifest = setup(monkeypatch)
    monkeypatch.setattr(live, 'fetch_binance_1h_klines_for_symbol', lambda s,a,b: fake_bars(s,a,b).drop(index=100))
    with pytest.raises(ValueError, match='不連續'):
        live.refresh_inputs(tmp_path, 'run-gap', manifest, 400*HOUR)


def test_network_failure_is_visible(tmp_path, monkeypatch):
    manifest = setup(monkeypatch)
    def fail(*args):
        raise RuntimeError('network unavailable')
    monkeypatch.setattr(live, 'fetch_binance_funding_rates_for_symbol', fail)
    with pytest.raises(RuntimeError, match='network unavailable'):
        live.refresh_inputs(tmp_path, 'run-fail', manifest, 400*HOUR)
    assert not (tmp_path/'model-research/live-inputs/run-fail').exists()
