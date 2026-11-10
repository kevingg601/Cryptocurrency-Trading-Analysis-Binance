"""
Command-line entrypoints for Fadachi Model Research:
- `prepare-data`: Select top 20 USDT-M Perpetual symbols and build 180-day 1h klines + funding dataset
- `download-weights`: Download official Kronos-Tokenizer-base, Kronos-small, and Kronos-base weights into workspace
- `train-lgbm`: Train and validate Long & Short LightGBM rankers on CPU
- `verify-kronos`: Run single-coin verification on Kronos-small first, then Kronos-base
- `evaluate`: Run offline evaluation and generate JSON, CSV, and Markdown comparison reports
- `infer`: Run a full manual inference (LightGBM ranking + Kronos top-candidates forecast) and commit to `data/model-research/<run-id>/`
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

from .data_prep import prepare_research_dataset
from .kronos_runner import download_kronos_weights
from .lightgbm_ranker import train_and_evaluate_lightgbm
from .offline_eval import run_offline_evaluation, verify_kronos_single_coin
from .worker import handle_run, handle_status


def main() -> int:
    parser = argparse.ArgumentParser(description="Fadachi LightGBM & Kronos Research CLI")
    parser.add_argument(
        "--data-dir",
        type=str,
        default="data",
        help="Path to Fadachi data directory (default: data)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_prep = sub.add_parser("prepare-data", help="Prepare 180-day 20-coin 1h klines and funding dataset")
    p_prep.add_argument("--max-symbols", type=int, default=20)
    p_prep.add_argument("--force-refresh-universe", action="store_true")
    p_prep.add_argument("--force-redownload", action="store_true")
    p_prep.add_argument("--rebuild-panel", action="store_true", help="Rebuild research_panel.parquet from existing local klines & funding parquets")

    p_dl = sub.add_parser("download-weights", help="Download official Kronos weights into workspace")
    p_dl.add_argument("--model", choices=["small", "base", "all"], default="all")

    p_train = sub.add_parser("train-lgbm", help="Train Long and Short LightGBM rankers on CPU")
    p_train.add_argument("--output-dir", type=str, default=None, help="New empty model output directory")

    p_ver = sub.add_parser("verify-kronos", help="Verify Kronos-small then Kronos-base on a single coin")
    p_ver.add_argument("--symbol", type=str, default="BTCUSDT")

    p_eval = sub.add_parser("evaluate", help="Run offline comparison on test split daily UTC 00:00 points")
    p_eval.add_argument("--max-pairs", type=int, default=600)
    p_eval.add_argument("--output-dir", type=str, default=None, help="Separate evaluation output directory; existing contents may be replaced")

    p_infer = sub.add_parser("infer", help="Run LightGBM + Kronos inference and save to data/model-research/<run-id>/")
    p_infer.add_argument("--model", choices=["small", "base"], default="small")
    p_infer.add_argument("--run-id", type=str, default=None)

    sub.add_parser("status", help="Print research environment, dataset, and model status")

    args = parser.parse_args()
    data_dir = Path(args.data_dir).resolve()
    mr_dir = data_dir / "model-research"
    datasets_dir = mr_dir / "datasets"
    models_dir = mr_dir / "models"
    weights_dir = mr_dir / "weights"
    eval_dir = mr_dir / "evaluation"

    if args.command == "prepare-data":
        manifest = prepare_research_dataset(
            data_dir=data_dir,
            max_symbols=args.max_symbols,
            force_refresh_universe=args.force_refresh_universe,
            force_redownload=args.force_redownload,
            rebuild_panel_only=args.rebuild_panel,
        )
        print(json.dumps({"status": "ok", "datasetVersion": manifest["datasetVersion"], "splitSummary": manifest["splitSummary"]}, ensure_ascii=False, indent=2))
        return 0

    if args.command == "download-weights":
        models = ["small", "base"] if args.model == "all" else [args.model]
        out = {}
        for m in models:
            out[m] = download_kronos_weights(weights_dir, m)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    if args.command == "train-lgbm":
        panel_path = datasets_dir / "research_panel.parquet"
        manifest_path = datasets_dir / "dataset_manifest.json"
        if not panel_path.exists() or not manifest_path.exists():
            raise FileNotFoundError("Dataset not found. Run `prepare-data` first.")
        panel_df = pd.read_parquet(panel_path)
        with open(manifest_path, "r", encoding="utf-8") as f:
            ds_manifest = json.load(f)
        if ds_manifest.get("pipelineVersion", 1) < 3:
            raise ValueError("研究資料早於 v3 資金費名目價值標籤修正；請先重建資料集")
        meta = train_and_evaluate_lightgbm(
            panel_df=panel_df,
            output_dir=Path(args.output_dir).resolve() if args.output_dir else models_dir,
            dataset_version=ds_manifest["datasetVersion"],
        )
        print(json.dumps(meta, ensure_ascii=False, indent=2))
        return 0

    if args.command == "verify-kronos":
        klines_path = datasets_dir / "klines_1h.parquet"
        if not klines_path.exists():
            raise FileNotFoundError("klines_1h.parquet not found. Run `prepare-data` first.")
        df_1h = pd.read_parquet(klines_path)
        verif = verify_kronos_single_coin(
            df_1h=df_1h,
            weights_root=weights_dir,
            output_dir=eval_dir,
            symbol=args.symbol,
        )
        print(json.dumps(verif, ensure_ascii=False, indent=2))
        return 0

    if args.command == "evaluate":
        report = run_offline_evaluation(
            data_dir=data_dir,
            models_dir=models_dir,
            weights_root=weights_dir,
            output_dir=Path(args.output_dir).resolve() if args.output_dir else eval_dir,
            max_pairs=args.max_pairs,
        )
        print(
            json.dumps(
                {
                    "status": "ok",
                    "kronosForecastComparison": report["kronosForecastComparison"],
                    "crossModelRankingComparison": report["crossModelRankingComparison"],
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    if args.command == "infer":
        res = handle_run(
            {
                "dataDir": str(data_dir),
                "kronosModel": args.model,
                "runId": args.run_id,
            }
        )
        print(json.dumps({"runId": res["runId"], "status": res["status"], "cutoffTime": res["cutoffTime"]}, ensure_ascii=False, indent=2))
        return 0

    if args.command == "status":
        res = handle_status({"dataDir": str(data_dir)})
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    return 1


if __name__ == "__main__":
    sys.exit(main())
