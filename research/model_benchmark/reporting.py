"""Durable machine-readable and Markdown run reports."""
from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from .common import atomic_json
from .registry import get_spec


def write_reports(run_dir: Path, manifest: dict[str, Any], results: dict[str, Any]) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    data = {"run": manifest, "results": results}
    atomic_json(run_dir / "comparison.json", data)
    rows = []
    for key, item in results.get("models", {}).items():
        full = item.get("full_metrics") or {}
        common = item.get("common_metrics") or {}
        predict = item.get("predict", {})
        rows.append({"model": key, "evaluation": "runtime", "device": item.get("device"),
                     "inference_device": predict.get("worker_device", item.get("device")),
                     "train_seconds": item.get("train_seconds"), "load_seconds": predict.get("worker_load_seconds"),
                     "inference_seconds": predict.get("worker_inference_seconds"),
                     "warm_inference_latency_ms": predict.get("warm_inference_latency_ms"),
                     "peak_vram_mib": predict.get("peak_vram_mib")})
        if "directions" in full:
            for direction, stats in full["directions"].items():
                rows.append({"model": key, "evaluation": "full_hour_test", "direction": direction,
                             "ndcg_at_5": stats.get("ndcg_at_5"), "ic": stats.get("ic"),
                             "top5_mean_net_return_ratio": stats.get("top5_mean_net_return"),
                             "top5_positive_ratio": stats.get("top5_positive_ratio")})
        elif full:
            rows.append({"model": key, "evaluation": "daily_common_forecast", "direction": "finetuned",
                         "return_mae": full.get("return_mae"), "directional_accuracy": full.get("directional_accuracy"),
                         "valid_direction_count": full.get("valid_direction_count"),
                         "no_change_return_mae": full.get("no_change_return_mae"), "momentum_return_mae": full.get("momentum_return_mae")})
            for variant, stats in full.get("variants", {}).items():
                rows.append({"model": key, "evaluation": "daily_common_forecast", "direction": variant,
                             "samples": stats.get("samples"), "return_mae": stats.get("return_mae"),
                             "directional_accuracy": stats.get("directional_accuracy"),
                             "valid_direction_count": stats.get("valid_direction_count")})
                for direction, rank_stats in stats.get("ranking", {}).get("directions", {}).items():
                    rows.append({"model": key, "evaluation": "daily_common_forecast_ranking", "direction": f"{variant}_{direction}",
                                 "ndcg_at_5": rank_stats.get("ndcg_at_5"), "ic": rank_stats.get("ic"),
                                 "top5_mean_net_return_ratio": rank_stats.get("top5_mean_net_return"),
                                 "top5_positive_ratio": rank_stats.get("top5_positive_ratio")})
        if common:
            if "directions" in common:
                for direction, stats in common["directions"].items():
                    rows.append({"model": key, "evaluation": "common_intersection", "direction": direction,
                                 "ndcg_at_5": stats.get("ndcg_at_5"), "ic": stats.get("ic"),
                                 "top5_mean_net_return_ratio": stats.get("top5_mean_net_return"),
                                 "top5_positive_ratio": stats.get("top5_positive_ratio")})
            else:
                rows.append({"model": key, "evaluation": "common_intersection", "direction": "forecast",
                             "return_mae": common.get("return_mae"), "directional_accuracy": common.get("directional_accuracy"),
                             "valid_direction_count": common.get("valid_direction_count")})
                for variant, stats in common.get("variants", {}).items():
                    rows.append({"model": key, "evaluation": "common_intersection", "direction": variant,
                                 "samples": stats.get("samples"), "return_mae": stats.get("return_mae"),
                                 "directional_accuracy": stats.get("directional_accuracy"),
                                 "valid_direction_count": stats.get("valid_direction_count")})
                    for direction, rank_stats in stats.get("ranking", {}).get("directions", {}).items():
                        rows.append({"model": key, "evaluation": "common_intersection_ranking", "direction": f"{variant}_{direction}",
                                     "ndcg_at_5": rank_stats.get("ndcg_at_5"), "ic": rank_stats.get("ic"),
                                     "top5_mean_net_return_ratio": rank_stats.get("top5_mean_net_return"),
                                     "top5_positive_ratio": rank_stats.get("top5_positive_ratio")})
    baseline = results.get("lightgbm_baseline", {})
    for direction, stats in baseline.get("common_metrics", {}).get("directions", {}).items():
        rows.append({"model": "lightgbm_existing", "evaluation": "common_intersection", "direction": direction,
                     "ndcg_at_5": stats.get("ndcg_at_5"), "ic": stats.get("ic"),
                     "top5_mean_net_return_ratio": stats.get("top5_mean_net_return"),
                     "top5_positive_ratio": stats.get("top5_positive_ratio")})
    csv_path = run_dir / "comparison.csv"
    fields = sorted({field for row in rows for field in row}) or ["model", "evaluation"]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    lines = ["# 四模型比較結果", "", f"- 執行狀態：**{manifest.get('status', 'RUNNING')}**",
             "- 評估層級：既有 v3 資料研究比較；TEST 已被查看，不代表全新獨立測試。",
             f"- 資料集：`{manifest.get('source_identity', {}).get('dataset_version', 'unknown')}`（pipeline v{manifest.get('source_identity', {}).get('pipeline_version', '?')}）",
             "- 市場：Binance USDT 永續合約；重疊 4 小時視窗不累加為帳戶報酬。",
             "- Chronos/TimesFM 的預訓練資料可能與此測試期間或幣種重疊；重疊情形未知，不宣稱獨立樣本外。", ""]
    if manifest.get("smoke"):
        lines.extend(["> **SMOKE_ONLY：小型介面／訓練路徑檢查，狀態不是完整比較；非正式性能結果。**", ""])
    lines.extend(["## 模型狀態", "", "| 模型 | 狀態 | 訓練裝置 | 推論裝置 | 訓練秒 | 載入秒 | 整批推論秒 | 暖機後單筆延遲 ms | 峰值顯存 MiB | 評估 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---|"])
    for key, item in results.get("models", {}).items():
        predict = item.get("predict", {})
        lines.append(f"| {key} | {item.get('status','—')} | {item.get('device','—')} | {predict.get('worker_device', item.get('device','—'))} | {_fmt(item.get('train_seconds'))} | {_fmt(predict.get('worker_load_seconds'))} | {_fmt(predict.get('worker_inference_seconds'))} | {_fmt(predict.get('warm_inference_latency_ms'))} | {_fmt(predict.get('peak_vram_mib'))} | {item.get('evaluation_status','—')} |")
    lines.extend(["", "## 完整小時級排序測試", "", "排序模型以 TEST 小時群組計算；淨報酬與 MAE 為小數比例 ratio，方向命中率不是交易勝率。", "",
                  "| 模型 | 方向 | 群組 | NDCG@5 | Spearman IC | Top 5 平均淨報酬 ratio | Top 5 正報酬比例 |", "|---|---|---:|---:|---:|---:|---:|"])
    for key, item in results.get("models", {}).items():
        full = item.get("full_metrics") or {}
        if "directions" in full:
            for direction, stats in full["directions"].items():
                lines.append(f"| {key} | {direction} | {stats.get('groups','—')} | {_fmt(stats.get('ndcg_at_5'))} | {_fmt(stats.get('ic'))} | {_fmt(stats.get('top5_mean_net_return'))} | {_fmt(stats.get('top5_positive_ratio'))} |")
    lines.extend(["", "## 時序模型每日共同點預測", "", "此處只涵蓋固定 UTC 00:00 點，不代表完整小時級 TEST。MAE 為 ratio；方向命中率以實際報酬非零樣本計算，不是交易勝率。", "",
                  "| 模型 | variant | 樣本 | 報酬 MAE ratio | 方向命中率 | 有效方向樣本 | 不變基準 MAE | 動能基準 MAE |", "|---|---|---:|---:|---:|---:|---:|---:|"])
    for key, item in results.get("models", {}).items():
        full = item.get("full_metrics") or {}
        for variant, stats in full.get("variants", {}).items():
            lines.append(f"| {key} | {variant} | {stats.get('samples','—')} | {_fmt(stats.get('return_mae'))} | {_fmt(stats.get('directional_accuracy'))} | {stats.get('valid_direction_count','—')} | {_fmt(stats.get('no_change_return_mae'))} | {_fmt(stats.get('momentum_return_mae'))} |")
    lines.extend(["", "## 固定共同樣本交集", "", "排序模型與時序模型 forecast ranking 皆以相同 pair intersection 評估；時序模型另外比較 MAE。", "",
                  "| 模型 | variant/方向 | 群組/樣本 | NDCG@5 | Spearman IC | Top 5 平均淨報酬 ratio | Top 5 正報酬比例 | 預測 MAE ratio | 方向命中率 | 有效方向樣本 |", "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|"])
    common = results.get("common_summary", {})
    for key, stats_root in common.get("models", {}).items():
        if "directions" in stats_root:
            for direction, stats in stats_root["directions"].items():
                lines.append(f"| {key} | {direction} | {stats.get('groups','—')} | {_fmt(stats.get('ndcg_at_5'))} | {_fmt(stats.get('ic'))} | {_fmt(stats.get('top5_mean_net_return'))} | {_fmt(stats.get('top5_positive_ratio'))} | — | — | — |")
        else:
            for variant, stats in stats_root.get("variants", {}).items():
                for direction, rank_stats in stats.get("ranking", {}).get("directions", {}).items():
                    lines.append(f"| {key} | {variant}_{direction} | {rank_stats.get('groups','—')} | {_fmt(rank_stats.get('ndcg_at_5'))} | {_fmt(rank_stats.get('ic'))} | {_fmt(rank_stats.get('top5_mean_net_return'))} | {_fmt(rank_stats.get('top5_positive_ratio'))} | — | — | — |")
                lines.append(f"| {key} | {variant} forecast | {stats.get('samples','—')} | — | — | — | — | {_fmt(stats.get('return_mae'))} | {_fmt(stats.get('directional_accuracy'))} | {stats.get('valid_direction_count','—')} |")
    lines.extend(["", "## LightGBM 固定參考", "", f"既有 LightGBM 共同樣本重推狀態：**{results.get('lightgbm_baseline', {}).get('status', '未執行')}**。"])
    baseline_common = results.get("lightgbm_baseline", {}).get("common_metrics", {})
    for direction, stats in baseline_common.get("directions", {}).items():
        lines.append(f"- {direction}: NDCG@5 `{_fmt(stats.get('ndcg_at_5'))}`, Spearman IC `{_fmt(stats.get('ic'))}`, Top 5 淨報酬 ratio `{_fmt(stats.get('top5_mean_net_return'))}`。")
    lines.extend(["", "## 微調前後與基準", ""])
    for key, item in results.get("models", {}).items():
        if get_spec(key).family != "forecast":
            continue
        fine = item.get("full_metrics") or {}
        variants = fine.get("variants", {})
        raw = variants.get("pretrained", {})
        tuned = variants.get("finetuned", fine)
        if raw:
            lines.append(f"- **{key}**：每日 UTC 00:00 TEST 預訓練 MAE `{_fmt(raw.get('return_mae'))}`，微調後 MAE `{_fmt(tuned.get('return_mae'))}`；方向命中率僅用實際非零報酬計算。")
        else:
            lines.append(f"- **{key}**：adapter 未提供微調前獨立預測指標；請見訓練 metadata 及限制。")
    lines.append("")
    if results.get("common_summary"):
        c = results["common_summary"]
        lines.extend([f"共同樣本交集：{c.get('intersection_pairs', 0)} pairs、{c.get('intersection_groups', 0)} timestamps；凍結 cohort 排除 {c.get('excluded_pairs', 0)} pairs。", ""])
        for model, variants in c.get("coverage_by_model_variant", {}).items():
            for variant, coverage in variants.items():
                lines.append(f"- Cohort coverage `{model}/{variant}`：有效 {coverage.get('valid_pairs', 0)}/{coverage.get('expected_pairs', 0)} pairs，缺少 {coverage.get('missing_pairs', 0)} pairs。")
        lines.append("")
    lines.extend(["## 研究限制", "", "- 候選模型、early stopping 與 checkpoint 僅依 TRAIN/VAL 選擇；TEST 僅作既有資料研究比較。",
                  "- 資料集為當前可交易幣種回溯，存在存活與選擇偏差。", "- 未成功產生預測的模型會列為失敗，不以零值補齊共同樣本。",
                  "- Chronos/TimesFM 預訓練資料與本 TEST 期間及幣種的重疊情況未知，不能宣稱時序模型結果是獨立樣本外。",
                  "- 若 adapter 未回報暖機後單筆延遲，表格留空；整批子程序推論秒數包含批次處理，不可當單筆延遲。",
                  "- 舊 Kronos 結果只作歷史參考，除非能驗證其輸入與固定共同 cohort 一致。", ""])
    (run_dir / "comparison.md").write_text("\n".join(lines), encoding="utf-8")


def _fmt(value: Any) -> str:
    if value is None:
        return "—"
    if isinstance(value, float):
        return f"{value:.6f}"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)
