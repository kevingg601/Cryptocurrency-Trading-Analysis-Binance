import type {
  AccountId,
  DecisionStatus,
  EquityPoint,
  ExperimentStatus,
  FundingCharge,
  ModelPaperConfig,
  ModelPaperDecisionRecord,
  ModelPaperExperimentRecord,
  ModelPaperGap,
  ModelSource,
  OrderAction,
  PaperAccountState,
  PaperFill,
  PaperOrder,
  PaperPosition,
} from '@fadachi/core';
import { abStorageTransaction } from '../ai/abStorage.ts';
import type { DuckDBClient } from '../storage/duckdb.ts';

export interface ControlRequestRecord {
  requestId: string;
  experimentId: string;
  action: string;
  createdAt: number;
  result: unknown;
}

export interface ModelPaperLease {
  experimentId: string;
  ownerToken: string;
  generation: number;
  expiresAt: number;
}

function mapExperiment(row: any): ModelPaperExperimentRecord {
  return {
    id: String(row.id),
    createdAt: Number(row.created_at),
    status: row.status as ExperimentStatus,
    config: JSON.parse(row.config_json) as ModelPaperConfig,
    modelKey: String(row.model_key),
    modelSource: JSON.parse(row.model_source_json) as ModelSource,
    universe: JSON.parse(row.universe_json) as string[],
    startedAt: Number(row.started_at),
    stoppedAt: row.stopped_at != null ? Number(row.stopped_at) : null,
    heartbeatAt: Number(row.heartbeat_at),
    statusReason: row.status_reason ?? null,
  };
}

function mapAccount(row: any): PaperAccountState {
  return {
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    cash: Number(row.cash),
    reserved: Number(row.reserved),
    realizedPnl: Number(row.realized_pnl),
    fees: Number(row.fees),
    funding: Number(row.funding),
    bankrupt: Boolean(row.bankrupt),
    degraded: Boolean(row.degraded),
    fundingPending: Boolean(row.funding_pending),
    stoppedThisHour: JSON.parse(row.stopped_this_hour_json || '[]') as string[],
    updatedAt: Number(row.updated_at),
  };
}

function mapDecision(row: any): ModelPaperDecisionRecord {
  const parsedSignals = row.signals_json ? JSON.parse(row.signals_json) : null;
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    modelKey: String(row.model_key),
    decisionHour: Number(row.decision_hour),
    status: row.status as DecisionStatus,
    attempts: Number(row.attempts),
    reason: row.reason ?? null,
    snapshotPath: row.snapshot_path ?? null,
    snapshotHash: row.snapshot_hash ?? null,
    modelVersions: parsedSignals?.modelVersions ?? null,
    signals: parsedSignals,
    createdAt: Number(row.created_at),
    submittedAt: row.submitted_at != null ? Number(row.submitted_at) : null,
  };
}

function mapOrder(row: any): PaperOrder {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    decisionId: String(row.decision_id),
    symbol: String(row.symbol),
    side: row.side,
    action: row.action as OrderAction,
    reason: String(row.reason),
    qty: Number(row.qty),
    refPrice: Number(row.ref_price),
    createdAt: Number(row.created_at),
    status: row.status,
    cancelReason: row.cancel_reason ?? null,
    positionId: row.position_id ?? null,
  };
}

function mapFill(row: any): PaperFill {
  return {
    orderId: String(row.order_id),
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    symbol: String(row.symbol),
    ...(row.action ? { action: row.action as OrderAction } : {}),
    aggId: Number(row.agg_id),
    tradeTime: Number(row.trade_time),
    receivedAt: Number(row.received_at),
    rawPrice: Number(row.raw_price),
    fillPrice: Number(row.fill_price),
    qty: Number(row.qty),
    fee: Number(row.fee),
    slippageCost: Number(row.slippage_cost),
    realizedPnl: Number(row.realized_pnl),
    positionId: String(row.position_id),
  };
}

function mapPosition(row: any): PaperPosition {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    symbol: String(row.symbol),
    side: row.side,
    qty: Number(row.qty),
    entryPrice: Number(row.entry_price),
    stopPrice: Number(row.stop_price),
    openedAt: Number(row.opened_at),
    openedDecisionHour: Number(row.opened_decision_hour),
    closedAt: row.closed_at != null ? Number(row.closed_at) : null,
    exitPrice: row.exit_price != null ? Number(row.exit_price) : null,
    exitReason: row.exit_reason ?? null,
    status: row.status,
  };
}

function mapFunding(row: any): FundingCharge {
  return {
    settlementId: String(row.settlement_id),
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    positionId: String(row.position_id),
    symbol: String(row.symbol),
    fundingTime: Number(row.funding_time),
    rate: Number(row.rate),
    markPrice: Number(row.mark_price),
    qty: Number(row.qty),
    amount: Number(row.amount),
    duringGap: Boolean(row.during_gap),
  };
}

function mapEquity(row: any): EquityPoint {
  return {
    experimentId: String(row.experiment_id),
    account: row.account as AccountId,
    ts: Number(row.ts),
    equity: Number(row.equity),
    cash: Number(row.cash),
    reserved: Number(row.reserved),
    unrealized: Number(row.unrealized),
    complete: Boolean(row.complete),
  };
}

function mapGap(row: any): ModelPaperGap {
  return {
    id: String(row.id),
    experimentId: String(row.experiment_id),
    account: row.account as AccountId | 'BOTH',
    kind: String(row.kind),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at != null ? Number(row.ended_at) : null,
    detail: row.detail ?? null,
  };
}

export class ModelPaperStore {
  readonly client: DuckDBClient;
  private readonly txRunner: <T>(work: (connection: DuckDBClient) => Promise<T>) => Promise<T>;

  constructor(client: DuckDBClient) {
    this.client = client;
    this.txRunner = abStorageTransaction(client);
  }

  withTx<T>(fn: (conn: DuckDBClient) => Promise<T>): Promise<T> {
    return this.txRunner(fn);
  }

  async insertExperiment(exp: ModelPaperExperimentRecord, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_experiments
       (id, created_at, status, config_json, model_key, model_source_json, universe_json, started_at, stopped_at, heartbeat_at, status_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      exp.id,
      exp.createdAt,
      exp.status,
      JSON.stringify(exp.config),
      exp.modelKey,
      JSON.stringify(exp.modelSource),
      JSON.stringify(exp.universe),
      exp.startedAt,
      exp.stoppedAt ?? null,
      exp.heartbeatAt,
      exp.statusReason ?? null,
    );
  }

  async getExperiment(id: string, conn: DuckDBClient = this.client): Promise<ModelPaperExperimentRecord | null> {
    const rows = await conn.all('SELECT * FROM model_paper_experiments WHERE id = ?;', id);
    return rows.length ? mapExperiment(rows[0]) : null;
  }

  async listExperiments(conn: DuckDBClient = this.client): Promise<ModelPaperExperimentRecord[]> {
    const rows = await conn.all('SELECT * FROM model_paper_experiments ORDER BY created_at DESC;');
    return rows.map(mapExperiment);
  }

  async getActiveExperiments(conn: DuckDBClient = this.client): Promise<ModelPaperExperimentRecord[]> {
    const rows = await conn.all(
      "SELECT * FROM model_paper_experiments WHERE status IN ('RUNNING', 'PAUSED', 'AWAITING_RESUME', 'STOPPING') ORDER BY created_at DESC;",
    );
    return rows.map(mapExperiment);
  }

  async updateExperimentStatus(
    id: string,
    status: ExperimentStatus,
    updates: { stoppedAt?: number | null; statusReason?: string | null; heartbeatAt?: number } = {},
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    const fields = ['status = ?'];
    const params: any[] = [status];
    if (updates.stoppedAt !== undefined) {
      fields.push('stopped_at = ?');
      params.push(updates.stoppedAt);
    }
    if (updates.statusReason !== undefined) {
      fields.push('status_reason = ?');
      params.push(updates.statusReason);
    }
    if (updates.heartbeatAt !== undefined) {
      fields.push('heartbeat_at = ?');
      params.push(updates.heartbeatAt);
    }
    params.push(id);
    await conn.run(`UPDATE model_paper_experiments SET ${fields.join(', ')} WHERE id = ?;`, ...params);
  }

  async updateHeartbeat(id: string, heartbeatAt: number, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run('UPDATE model_paper_experiments SET heartbeat_at = ? WHERE id = ?;', heartbeatAt, id);
  }

  async insertAccounts(accounts: PaperAccountState[], conn: DuckDBClient = this.client): Promise<void> {
    for (const acc of accounts) {
      await this.upsertAccount(acc, conn);
    }
  }

  async upsertAccount(acc: PaperAccountState, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_accounts
       (experiment_id, account, cash, reserved, realized_pnl, fees, funding, bankrupt, degraded, funding_pending, stopped_this_hour_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (experiment_id, account) DO UPDATE SET
         cash = excluded.cash,
         reserved = excluded.reserved,
         realized_pnl = excluded.realized_pnl,
         fees = excluded.fees,
         funding = excluded.funding,
         bankrupt = excluded.bankrupt,
         degraded = excluded.degraded,
         funding_pending = excluded.funding_pending,
         stopped_this_hour_json = excluded.stopped_this_hour_json,
         updated_at = excluded.updated_at;`,
      acc.experimentId,
      acc.account,
      acc.cash,
      acc.reserved,
      acc.realizedPnl,
      acc.fees,
      acc.funding,
      acc.bankrupt,
      acc.degraded,
      acc.fundingPending,
      JSON.stringify(acc.stoppedThisHour),
      acc.updatedAt,
    );
  }

  async getAccount(experimentId: string, account: AccountId, conn: DuckDBClient = this.client): Promise<PaperAccountState | null> {
    const rows = await conn.all(
      'SELECT * FROM model_paper_accounts WHERE experiment_id = ? AND account = ?;',
      experimentId,
      account,
    );
    return rows.length ? mapAccount(rows[0]) : null;
  }

  async getAccounts(experimentId: string, conn: DuckDBClient = this.client): Promise<{ A: PaperAccountState; B: PaperAccountState }> {
    const rows = await conn.all(
      'SELECT * FROM model_paper_accounts WHERE experiment_id = ? ORDER BY account ASC;',
      experimentId,
    );
    const map: Partial<Record<AccountId, PaperAccountState>> = {};
    for (const r of rows) {
      const mapped = mapAccount(r);
      map[mapped.account] = mapped;
    }
    if (!map.A || !map.B) {
      throw new Error(`找不到實驗 ${experimentId} 的完整 A/B 帳戶資料`);
    }
    return { A: map.A, B: map.B };
  }

  async claimDecision(
    params: {
      id: string;
      experimentId: string;
      modelKey: string;
      decisionHour: number;
      now: number;
      allowFailedRetry?: boolean;
    },
    conn?: DuckDBClient,
  ): Promise<{ claimed: boolean; decision: ModelPaperDecisionRecord }> {
    const work = async (tx: DuckDBClient) => {
      const existing = await tx.all(
        'SELECT * FROM model_paper_decisions WHERE experiment_id = ? AND model_key = ? AND decision_hour = ?;',
        params.experimentId,
        params.modelKey,
        params.decisionHour,
      );
      if (existing.length === 0) {
        await tx.run(
          `INSERT INTO model_paper_decisions
           (id, experiment_id, model_key, decision_hour, status, attempts, reason, snapshot_path, snapshot_hash, signals_json, created_at, submitted_at)
           VALUES (?, ?, ?, ?, 'PENDING', 1, NULL, NULL, NULL, NULL, ?, NULL);`,
          params.id,
          params.experimentId,
          params.modelKey,
          params.decisionHour,
          params.now,
        );
        const created = await tx.all('SELECT * FROM model_paper_decisions WHERE id = ?;', params.id);
        return { claimed: true, decision: mapDecision(created[0]) };
      }

      const row = mapDecision(existing[0]);
      const retryable =
        row.status === 'PENDING_RETRY' || (Boolean(params.allowFailedRetry) && row.status === 'FAILED');
      if (!retryable) {
        return { claimed: false, decision: row };
      }

      await tx.run(
        "UPDATE model_paper_decisions SET status = 'PENDING', attempts = attempts + 1, reason = NULL WHERE id = ?;",
        row.id,
      );
      const updated = await tx.all('SELECT * FROM model_paper_decisions WHERE id = ?;', row.id);
      return { claimed: true, decision: mapDecision(updated[0]) };
    };

    return conn ? work(conn) : this.withTx(work);
  }

  async updateDecision(
    params: {
      id: string;
      status: DecisionStatus;
      reason?: string | null;
      snapshotPath?: string | null;
      snapshotHash?: string | null;
      signals?: ModelPaperDecisionRecord['signals'];
      submittedAt?: number | null;
    },
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    await conn.run(
      `UPDATE model_paper_decisions
       SET status = ?,
           reason = ?,
           snapshot_path = COALESCE(?, snapshot_path),
           snapshot_hash = COALESCE(?, snapshot_hash),
           signals_json = COALESCE(?, signals_json),
           submitted_at = COALESCE(?, submitted_at)
       WHERE id = ?;`,
      params.status,
      params.reason ?? null,
      params.snapshotPath ?? null,
      params.snapshotHash ?? null,
      params.signals !== undefined ? JSON.stringify(params.signals) : null,
      params.submittedAt ?? null,
      params.id,
    );
  }

  async failOrphanedPendingDecisions(
    experimentId: string,
    reason: string,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    await conn.run(
      "UPDATE model_paper_decisions SET status = 'FAILED', reason = ? WHERE experiment_id = ? AND status = 'PENDING';",
      reason,
      experimentId,
    );
  }

  async getDecisionByHour(
    experimentId: string,
    modelKey: string,
    decisionHour: number,
    conn: DuckDBClient = this.client,
  ): Promise<ModelPaperDecisionRecord | null> {
    const rows = await conn.all(
      'SELECT * FROM model_paper_decisions WHERE experiment_id = ? AND model_key = ? AND decision_hour = ?;',
      experimentId,
      modelKey,
      decisionHour,
    );
    return rows.length ? mapDecision(rows[0]) : null;
  }

  async listDecisions(experimentId: string, conn: DuckDBClient = this.client): Promise<ModelPaperDecisionRecord[]> {
    const rows = await conn.all(
      'SELECT * FROM model_paper_decisions WHERE experiment_id = ? ORDER BY decision_hour DESC, created_at DESC;',
      experimentId,
    );
    return rows.map(mapDecision);
  }

  async insertOrderIfAbsent(order: PaperOrder, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_orders
       (id, experiment_id, account, decision_id, symbol, side, action, reason, qty, ref_price, created_at, status, cancel_reason, position_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING;`,
      order.id,
      order.experimentId,
      order.account,
      order.decisionId,
      order.symbol,
      order.side,
      order.action,
      order.reason,
      order.qty,
      order.refPrice,
      order.createdAt,
      order.status,
      order.cancelReason ?? null,
      order.positionId ?? null,
    );
  }

  async upgradeOrderToStopLoss(
    orderId: string,
    createdAt: number,
    refPrice: number,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    await conn.run(
      "UPDATE model_paper_orders SET reason = 'STOP_LOSS', created_at = ?, ref_price = ? WHERE id = ? AND status = 'PENDING';",
      createdAt,
      refPrice,
      orderId,
    );
  }

  async markOrderFilled(
    orderId: string,
    positionId: string | null,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    await conn.run(
      "UPDATE model_paper_orders SET status = 'FILLED', position_id = COALESCE(?, position_id) WHERE id = ?;",
      positionId,
      orderId,
    );
  }

  async cancelOrder(orderId: string, cancelReason: string, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      "UPDATE model_paper_orders SET status = 'CANCELLED', cancel_reason = ? WHERE id = ? AND status = 'PENDING';",
      cancelReason,
      orderId,
    );
  }

  async cancelPendingEntries(
    experimentId: string,
    account: AccountId | null,
    cancelReason: string,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    if (account) {
      await conn.run(
        "UPDATE model_paper_orders SET status = 'CANCELLED', cancel_reason = ? WHERE experiment_id = ? AND account = ? AND action = 'ENTRY' AND status = 'PENDING';",
        cancelReason,
        experimentId,
        account,
      );
    } else {
      await conn.run(
        "UPDATE model_paper_orders SET status = 'CANCELLED', cancel_reason = ? WHERE experiment_id = ? AND action = 'ENTRY' AND status = 'PENDING';",
        cancelReason,
        experimentId,
      );
    }
  }

  async listOrders(
    experimentId: string,
    account?: AccountId,
    conn: DuckDBClient = this.client,
  ): Promise<PaperOrder[]> {
    const sql = account
      ? 'SELECT * FROM model_paper_orders WHERE experiment_id = ? AND account = ? ORDER BY created_at DESC;'
      : 'SELECT * FROM model_paper_orders WHERE experiment_id = ? ORDER BY created_at DESC;';
    const rows = account ? await conn.all(sql, experimentId, account) : await conn.all(sql, experimentId);
    return rows.map(mapOrder);
  }

  async listPendingOrders(
    experimentId: string,
    account?: AccountId,
    conn: DuckDBClient = this.client,
  ): Promise<PaperOrder[]> {
    const sql = account
      ? "SELECT * FROM model_paper_orders WHERE experiment_id = ? AND account = ? AND status = 'PENDING' ORDER BY created_at ASC;"
      : "SELECT * FROM model_paper_orders WHERE experiment_id = ? AND status = 'PENDING' ORDER BY created_at ASC;";
    const rows = account ? await conn.all(sql, experimentId, account) : await conn.all(sql, experimentId);
    return rows.map(mapOrder);
  }

  async insertFillIfAbsent(fill: PaperFill, conn: DuckDBClient = this.client): Promise<boolean> {
    const existing = await conn.all('SELECT order_id FROM model_paper_fills WHERE order_id = ?;', fill.orderId);
    if (existing.length > 0) return false;
    await conn.run(
      `INSERT INTO model_paper_fills
       (order_id, experiment_id, account, symbol, agg_id, trade_time, received_at, raw_price, fill_price, qty, fee, slippage_cost, realized_pnl, position_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (order_id) DO NOTHING;`,
      fill.orderId,
      fill.experimentId,
      fill.account,
      fill.symbol,
      fill.aggId,
      fill.tradeTime,
      fill.receivedAt,
      fill.rawPrice,
      fill.fillPrice,
      fill.qty,
      fill.fee,
      fill.slippageCost,
      fill.realizedPnl,
      fill.positionId,
    );
    return true;
  }

  async hasFillForAggId(
    experimentId: string,
    account: AccountId,
    symbol: string,
    aggId: number,
    conn: DuckDBClient = this.client,
  ): Promise<boolean> {
    const rows = await conn.all(
      'SELECT order_id FROM model_paper_fills WHERE experiment_id = ? AND account = ? AND symbol = ? AND agg_id = ? LIMIT 1;',
      experimentId,
      account,
      symbol,
      aggId,
    );
    return rows.length > 0;
  }

  async listFills(
    experimentId: string,
    account?: AccountId,
    conn: DuckDBClient = this.client,
  ): Promise<PaperFill[]> {
    const sql = account
      ? `SELECT f.*, o.action AS action FROM model_paper_fills f
         LEFT JOIN model_paper_orders o ON f.order_id = o.id
         WHERE f.experiment_id = ? AND f.account = ?
         ORDER BY f.received_at ASC, f.agg_id ASC;`
      : `SELECT f.*, o.action AS action FROM model_paper_fills f
         LEFT JOIN model_paper_orders o ON f.order_id = o.id
         WHERE f.experiment_id = ?
         ORDER BY f.received_at ASC, f.agg_id ASC;`;
    const rows = account ? await conn.all(sql, experimentId, account) : await conn.all(sql, experimentId);
    return rows.map(mapFill);
  }

  async upsertPosition(pos: PaperPosition, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_positions
       (id, experiment_id, account, symbol, side, qty, entry_price, stop_price, opened_at, opened_decision_hour, closed_at, exit_price, exit_reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         closed_at = excluded.closed_at,
         exit_price = excluded.exit_price,
         exit_reason = excluded.exit_reason,
         status = excluded.status;`,
      pos.id,
      pos.experimentId,
      pos.account,
      pos.symbol,
      pos.side,
      pos.qty,
      pos.entryPrice,
      pos.stopPrice,
      pos.openedAt,
      pos.openedDecisionHour ?? 0,
      pos.closedAt ?? null,
      pos.exitPrice ?? null,
      pos.exitReason ?? null,
      pos.status,
    );
  }

  async listPositions(
    experimentId: string,
    account?: AccountId,
    status?: 'OPEN' | 'CLOSED',
    conn: DuckDBClient = this.client,
  ): Promise<PaperPosition[]> {
    const clauses = ['experiment_id = ?'];
    const params: any[] = [experimentId];
    if (account) {
      clauses.push('account = ?');
      params.push(account);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    const rows = await conn.all(
      `SELECT * FROM model_paper_positions WHERE ${clauses.join(' AND ')} ORDER BY opened_at ASC;`,
      ...params,
    );
    return rows.map(mapPosition);
  }

  async insertFundingIfAbsent(charge: FundingCharge, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_funding
       (settlement_id, experiment_id, account, position_id, symbol, funding_time, rate, mark_price, qty, amount, during_gap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (settlement_id) DO NOTHING;`,
      charge.settlementId,
      charge.experimentId,
      charge.account,
      charge.positionId,
      charge.symbol,
      charge.fundingTime,
      charge.rate,
      charge.markPrice,
      charge.qty,
      charge.amount,
      charge.duringGap,
    );
  }

  async listFunding(
    experimentId: string,
    account?: AccountId,
    conn: DuckDBClient = this.client,
  ): Promise<FundingCharge[]> {
    const sql = account
      ? 'SELECT * FROM model_paper_funding WHERE experiment_id = ? AND account = ? ORDER BY funding_time ASC;'
      : 'SELECT * FROM model_paper_funding WHERE experiment_id = ? ORDER BY funding_time ASC;';
    const rows = account ? await conn.all(sql, experimentId, account) : await conn.all(sql, experimentId);
    return rows.map(mapFunding);
  }

  async upsertEquityPoint(pt: EquityPoint, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_equity
       (experiment_id, account, ts, equity, cash, reserved, unrealized, complete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (experiment_id, account, ts) DO UPDATE SET
         equity = excluded.equity,
         cash = excluded.cash,
         reserved = excluded.reserved,
         unrealized = excluded.unrealized,
         complete = excluded.complete;`,
      pt.experimentId,
      pt.account,
      pt.ts,
      pt.equity,
      pt.cash,
      pt.reserved,
      pt.unrealized,
      pt.complete,
    );
  }

  async listEquityPoints(
    experimentId: string,
    account?: AccountId,
    conn: DuckDBClient = this.client,
  ): Promise<EquityPoint[]> {
    const sql = account
      ? 'SELECT * FROM model_paper_equity WHERE experiment_id = ? AND account = ? ORDER BY ts ASC;'
      : 'SELECT * FROM model_paper_equity WHERE experiment_id = ? ORDER BY ts ASC, account ASC;';
    const rows = account ? await conn.all(sql, experimentId, account) : await conn.all(sql, experimentId);
    return rows.map(mapEquity);
  }

  async insertGap(gap: ModelPaperGap, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_gaps (id, experiment_id, account, kind, started_at, ended_at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING;`,
      gap.id,
      gap.experimentId,
      gap.account,
      gap.kind,
      gap.startedAt,
      gap.endedAt ?? null,
      gap.detail ?? null,
    );
  }

  async closeOpenGaps(
    experimentId: string,
    account: AccountId | 'BOTH' | null,
    endedAt: number,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    if (account) {
      await conn.run(
        'UPDATE model_paper_gaps SET ended_at = ? WHERE experiment_id = ? AND account = ? AND ended_at IS NULL;',
        endedAt,
        experimentId,
        account,
      );
    } else {
      await conn.run(
        'UPDATE model_paper_gaps SET ended_at = ? WHERE experiment_id = ? AND ended_at IS NULL;',
        endedAt,
        experimentId,
      );
    }
  }

  async listGaps(experimentId: string, conn: DuckDBClient = this.client): Promise<ModelPaperGap[]> {
    const rows = await conn.all(
      'SELECT * FROM model_paper_gaps WHERE experiment_id = ? ORDER BY started_at ASC;',
      experimentId,
    );
    return rows.map(mapGap);
  }

  async getControlRequest(requestId: string, conn: DuckDBClient = this.client): Promise<ControlRequestRecord | null> {
    const rows = await conn.all('SELECT * FROM model_paper_control_requests WHERE request_id = ?;', requestId);
    if (!rows.length) return null;
    return {
      requestId: String(rows[0].request_id),
      experimentId: String(rows[0].experiment_id),
      action: String(rows[0].action),
      createdAt: Number(rows[0].created_at),
      result: JSON.parse(rows[0].result_json),
    };
  }

  async saveControlRequest(
    req: ControlRequestRecord,
    conn: DuckDBClient = this.client,
  ): Promise<void> {
    await conn.run(
      `INSERT INTO model_paper_control_requests (request_id, experiment_id, action, created_at, result_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (request_id) DO NOTHING;`,
      req.requestId,
      req.experimentId,
      req.action,
      req.createdAt,
      JSON.stringify(req.result),
    );
  }

  async getLease(experimentId: string, conn: DuckDBClient = this.client): Promise<ModelPaperLease | null> {
    const rows = await conn.all('SELECT * FROM model_paper_leases WHERE experiment_id = ?;', experimentId);
    if (!rows.length) return null;
    return {
      experimentId: String(rows[0].experiment_id),
      ownerToken: String(rows[0].owner_token),
      generation: Number(rows[0].generation),
      expiresAt: Number(rows[0].expires_at),
    };
  }

  async claimLease(
    experimentId: string,
    ownerToken: string,
    generation: number,
    now: number,
    ttlMs: number,
    conn: DuckDBClient = this.client,
  ): Promise<{ owner: true; lease: ModelPaperLease } | { owner: false; existing: ModelPaperLease }> {
    const existing = await this.getLease(experimentId, conn);
    if (existing && existing.ownerToken !== ownerToken && existing.expiresAt > now) {
      return { owner: false, existing };
    }
    const lease: ModelPaperLease = {
      experimentId,
      ownerToken,
      generation,
      expiresAt: now + ttlMs,
    };
    await conn.run(
      `INSERT INTO model_paper_leases (experiment_id, owner_token, generation, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (experiment_id) DO UPDATE SET
         owner_token = excluded.owner_token,
         generation = excluded.generation,
         expires_at = excluded.expires_at;`,
      lease.experimentId,
      lease.ownerToken,
      lease.generation,
      lease.expiresAt,
    );
    return { owner: true, lease };
  }

  async renewLease(
    experimentId: string,
    ownerToken: string,
    generation: number,
    now: number,
    ttlMs: number,
    conn: DuckDBClient = this.client,
  ): Promise<boolean> {
    const existing = await this.getLease(experimentId, conn);
    if (!existing || existing.ownerToken !== ownerToken || existing.generation !== generation || existing.expiresAt <= now) {
      return false;
    }
    await conn.run(
      'UPDATE model_paper_leases SET expires_at = ? WHERE experiment_id = ? AND owner_token = ?;',
      now + ttlMs,
      experimentId,
      ownerToken,
    );
    return true;
  }

  async releaseLease(experimentId: string, ownerToken: string, conn: DuckDBClient = this.client): Promise<void> {
    await conn.run(
      'DELETE FROM model_paper_leases WHERE experiment_id = ? AND owner_token = ?;',
      experimentId,
      ownerToken,
    );
  }
}
