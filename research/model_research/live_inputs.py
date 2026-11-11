"""Save current closed-hour inference inputs without changing training datasets."""
from __future__ import annotations

import json
from pathlib import Path
import time

import pandas as pd

from .data_prep import fetch_binance_1h_klines_for_symbol, fetch_binance_funding_rates_for_symbol, sha256_file
from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h


def refresh_inputs(data_dir: Path, run_id: str, source_manifest: dict, now_ms: int):
    cutoff = now_ms // ONE_HOUR_MS * ONE_HOUR_MS
    start = cutoff - 320 * ONE_HOUR_MS
    symbols = list(dict.fromkeys(source_manifest.get('universe', {}).get('symbols', [])))
    if len(symbols) < 10 or len(symbols) > 50:
        raise ValueError('即時研究標的清單須包含 10～50 個幣種')
    bars, funding = [], []
    # Requests are deliberately sequential and bounded to the fixed research universe.
    for symbol in symbols:
        frame = fetch_binance_1h_klines_for_symbol(symbol, start, cutoff)
        if frame.empty or int(frame.open_time.max()) != cutoff - ONE_HOUR_MS:
            raise ValueError(f'{symbol} 最新已收盤 1h 行情尚未就緒；未退回歷史資料')
        bars.append(frame)
        rates = fetch_binance_funding_rates_for_symbol(symbol, cutoff - 8 * 24 * ONE_HOUR_MS, cutoff)
        if rates.empty:
            raise ValueError(f'{symbol} 無法取得歷史資金費率；未退回舊資料')
        known_rates = rates[rates.funding_time <= cutoff]
        if known_rates.empty:
            raise ValueError(f'{symbol} 缺少截止時間以前的資金費率')
        funding.append(known_rates)
    clean, _ = validate_and_deduplicate_1h(pd.concat(bars, ignore_index=True), cutoff_ms=cutoff)
    for symbol in symbols:
        times = clean.loc[clean.symbol == symbol, 'open_time'].sort_values().tail(256)
        if len(times) != 256 or int(times.iloc[-1]) != cutoff - ONE_HOUR_MS or not times.diff().dropna().eq(ONE_HOUR_MS).all():
            raise ValueError(f'{symbol} 最新 256 根已收盤行情不連續；未退回歷史資料')
    rates = pd.concat(funding, ignore_index=True)
    folder = Path(data_dir) / 'model-research/live-inputs' / run_id
    folder.mkdir(parents=True, exist_ok=False)
    path = folder / 'klines_1h.parquet'
    clean.to_parquet(path, index=False)
    rates.to_parquet(folder / 'funding_rates.parquet', index=False)
    manifest = dict(source_manifest)
    manifest.update(datasetVersion='live-' + run_id, trainingDatasetVersion=source_manifest.get('datasetVersion'),
                    inputMode='live', fetchedAt=int(time.time() * 1000), inputCutoffTime=cutoff,
                    inputHashes={name: sha256_file(folder / name)
                                 for name in ['klines_1h.parquet', 'funding_rates.parquet']})
    (folder / 'input_manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return clean, rates, path, manifest, cutoff
