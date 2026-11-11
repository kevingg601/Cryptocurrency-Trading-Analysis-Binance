-- 原始逐筆成交（熱資料；flush 至 Parquet 後刪除）
CREATE TABLE IF NOT EXISTS agg_trades (
  market         VARCHAR NOT NULL,
  symbol         VARCHAR NOT NULL,
  agg_id         BIGINT  NOT NULL,
  price          DOUBLE  NOT NULL,
  qty            DOUBLE  NOT NULL,
  first_id       BIGINT,
  last_id        BIGINT,
  trade_time     BIGINT  NOT NULL,
  recv_time      BIGINT  NOT NULL,
  is_buyer_maker BOOLEAN NOT NULL,
  source         VARCHAR NOT NULL,
  PRIMARY KEY (market, symbol, agg_id)
);

-- 1m K 線（全市場，永久；其他週期查詢時聚合）
CREATE TABLE IF NOT EXISTS klines_1m (
  market           VARCHAR NOT NULL,
  symbol           VARCHAR NOT NULL,
  open_time        BIGINT  NOT NULL,
  open             DOUBLE  NOT NULL,
  high             DOUBLE  NOT NULL,
  low              DOUBLE  NOT NULL,
  close            DOUBLE  NOT NULL,
  volume           DOUBLE  NOT NULL,
  quote_volume     DOUBLE  NOT NULL,
  trades           INTEGER,
  taker_buy_base   DOUBLE,
  taker_buy_quote  DOUBLE,
  is_final         BOOLEAN NOT NULL,
  source           VARCHAR NOT NULL,
  PRIMARY KEY (market, symbol, open_time)
);

-- 收集工作階段與缺口
CREATE TABLE IF NOT EXISTS collection_sessions (
  id          VARCHAR PRIMARY KEY,
  market      VARCHAR NOT NULL,
  started_at  BIGINT  NOT NULL,
  ended_at    BIGINT,
  end_reason  VARCHAR
);

CREATE TABLE IF NOT EXISTS gaps (
  id           VARCHAR PRIMARY KEY,
  market       VARCHAR NOT NULL,
  symbol       VARCHAR NOT NULL,
  dataset      VARCHAR NOT NULL, -- 'aggtrades' | 'klines_1m'
  from_time    BIGINT  NOT NULL,
  to_time      BIGINT  NOT NULL,
  from_id      BIGINT,
  to_id        BIGINT,
  status       VARCHAR NOT NULL, -- 'open' | 'backfilled' | 'unrecoverable'
  detected_at  BIGINT  NOT NULL,
  resolved_at  BIGINT
);

-- 伺服端警報與跟進計畫事件
CREATE TABLE IF NOT EXISTS alert_events (
  id            VARCHAR PRIMARY KEY,
  market        VARCHAR NOT NULL,
  symbol        VARCHAR NOT NULL,
  type          VARCHAR NOT NULL,
  detected_at   BIGINT  NOT NULL,
  settings_hash VARCHAR,
  payload       VARCHAR -- JSON string
);

CREATE TABLE IF NOT EXISTS follow_plan_events (
  id       VARCHAR PRIMARY KEY,
  plan_id  VARCHAR NOT NULL,
  market   VARCHAR NOT NULL,
  symbol   VARCHAR NOT NULL,
  state       VARCHAR NOT NULL,
  event_time  BIGINT  NOT NULL,
  payload     VARCHAR -- JSON string
);

-- 模擬帳戶與自動交易批次
CREATE TABLE IF NOT EXISTS auto_batches (
  id         VARCHAR PRIMARY KEY,
  market     VARCHAR NOT NULL,
  status     VARCHAR NOT NULL,
  snapshot   VARCHAR NOT NULL, -- JSON string
  updated_at BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_accounts (
  market     VARCHAR PRIMARY KEY,
  balance    DOUBLE  NOT NULL,
  trades     VARCHAR NOT NULL, -- JSON string
  history    VARCHAR NOT NULL, -- JSON string
  updated_at BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS universe_changes (
  change_time BIGINT  NOT NULL,
  market  VARCHAR NOT NULL,
  added   VARCHAR NOT NULL, -- JSON string
  removed VARCHAR NOT NULL  -- JSON string
);

-- AI 分析資料快照、結果與決策
CREATE TABLE IF NOT EXISTS ai_data_snapshots (
  id            VARCHAR PRIMARY KEY,
  symbol        VARCHAR NOT NULL,
  market        VARCHAR NOT NULL,
  cutoff_time   BIGINT  NOT NULL,
  valid_until   BIGINT  NOT NULL,
  hash          VARCHAR NOT NULL,
  degraded      BOOLEAN NOT NULL,
  payload       VARCHAR NOT NULL, -- JSON string
  created_at    BIGINT  NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_analysis_results (
  id            VARCHAR PRIMARY KEY,
  snapshot_id   VARCHAR NOT NULL,
  symbol        VARCHAR NOT NULL,
  market        VARCHAR NOT NULL,
  model         VARCHAR NOT NULL,
  direction     VARCHAR NOT NULL,
  confidence    DOUBLE  NOT NULL,
  generated_at  BIGINT  NOT NULL,
  expires_at    BIGINT  NOT NULL,
  payload       VARCHAR NOT NULL  -- JSON string
);

CREATE TABLE IF NOT EXISTS ai_entry_decisions (
  id            VARCHAR PRIMARY KEY,
  batch_id      VARCHAR NOT NULL,
  plan_id       VARCHAR NOT NULL,
  symbol        VARCHAR NOT NULL,
  market        VARCHAR NOT NULL,
  account       VARCHAR NOT NULL,
  allowed       BOOLEAN NOT NULL,
  reason        VARCHAR NOT NULL,
  analysis_id   VARCHAR,
  timestamp     BIGINT  NOT NULL,
  payload       VARCHAR NOT NULL  -- JSON string
);

-- A/B 成對對照批次（原子保存、唯一批次 ID 與 revision 單一寫入者控制）
CREATE TABLE IF NOT EXISTS ab_trading_batches (
  id          VARCHAR PRIMARY KEY,
  market      VARCHAR NOT NULL,
  status      VARCHAR NOT NULL,
  revision    INTEGER NOT NULL,
  model       VARCHAR NOT NULL,
  started_at  BIGINT  NOT NULL,
  ended_at    BIGINT,
  payload     VARCHAR NOT NULL, -- JSON string with encoded Infinity
  updated_at  BIGINT  NOT NULL
);

-- 模型虛擬帳戶前向測試（Chronos-2 / LightGBM A/B）
CREATE TABLE IF NOT EXISTS model_paper_experiments (
  id VARCHAR PRIMARY KEY,
  created_at BIGINT,
  status VARCHAR,
  config_json VARCHAR,
  model_key VARCHAR,
  model_source_json VARCHAR,
  universe_json VARCHAR,
  started_at BIGINT,
  stopped_at BIGINT,
  heartbeat_at BIGINT,
  status_reason VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_accounts (
  experiment_id VARCHAR,
  account VARCHAR,
  cash DOUBLE,
  reserved DOUBLE,
  realized_pnl DOUBLE,
  fees DOUBLE,
  funding DOUBLE,
  bankrupt BOOLEAN,
  degraded BOOLEAN,
  funding_pending BOOLEAN,
  stopped_this_hour_json VARCHAR,
  updated_at BIGINT,
  PRIMARY KEY (experiment_id, account)
);

CREATE TABLE IF NOT EXISTS model_paper_decisions (
  id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  model_key VARCHAR,
  decision_hour BIGINT,
  status VARCHAR,
  attempts INTEGER,
  reason VARCHAR,
  snapshot_path VARCHAR,
  snapshot_hash VARCHAR,
  signals_json VARCHAR,
  created_at BIGINT,
  submitted_at BIGINT,
  UNIQUE (experiment_id, model_key, decision_hour)
);

CREATE TABLE IF NOT EXISTS model_paper_orders (
  id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  account VARCHAR,
  decision_id VARCHAR,
  symbol VARCHAR,
  side VARCHAR,
  action VARCHAR,
  reason VARCHAR,
  qty DOUBLE,
  ref_price DOUBLE,
  created_at BIGINT,
  status VARCHAR,
  cancel_reason VARCHAR,
  position_id VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_fills (
  order_id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  account VARCHAR,
  symbol VARCHAR,
  agg_id BIGINT,
  trade_time BIGINT,
  received_at BIGINT,
  raw_price DOUBLE,
  fill_price DOUBLE,
  qty DOUBLE,
  fee DOUBLE,
  slippage_cost DOUBLE,
  realized_pnl DOUBLE,
  position_id VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_positions (
  id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  account VARCHAR,
  symbol VARCHAR,
  side VARCHAR,
  qty DOUBLE,
  entry_price DOUBLE,
  stop_price DOUBLE,
  opened_at BIGINT,
  opened_decision_hour BIGINT,
  closed_at BIGINT,
  exit_price DOUBLE,
  exit_reason VARCHAR,
  status VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_funding (
  settlement_id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  account VARCHAR,
  position_id VARCHAR,
  symbol VARCHAR,
  funding_time BIGINT,
  rate DOUBLE,
  mark_price DOUBLE,
  qty DOUBLE,
  amount DOUBLE,
  during_gap BOOLEAN
);

CREATE TABLE IF NOT EXISTS model_paper_equity (
  experiment_id VARCHAR,
  account VARCHAR,
  ts BIGINT,
  equity DOUBLE,
  cash DOUBLE,
  reserved DOUBLE,
  unrealized DOUBLE,
  complete BOOLEAN,
  PRIMARY KEY (experiment_id, account, ts)
);

CREATE TABLE IF NOT EXISTS model_paper_gaps (
  id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  account VARCHAR,
  kind VARCHAR,
  started_at BIGINT,
  ended_at BIGINT,
  detail VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_control_requests (
  request_id VARCHAR PRIMARY KEY,
  experiment_id VARCHAR,
  action VARCHAR,
  created_at BIGINT,
  result_json VARCHAR
);

CREATE TABLE IF NOT EXISTS model_paper_leases (
  experiment_id VARCHAR PRIMARY KEY,
  owner_token VARCHAR,
  generation BIGINT,
  expires_at BIGINT
);
