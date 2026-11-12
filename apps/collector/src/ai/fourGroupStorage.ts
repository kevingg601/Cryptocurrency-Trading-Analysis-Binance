import { randomUUID } from 'node:crypto';
import {
  FOUR_GROUP_IDS,
  LGBM_RANK_TOP_K,
  SNAPSHOT_VALIDITY_MS,
  isRemoteOllamaUrl,
  parseWithInfinity,
  restoreInfinityInOrders,
  sanitizeOllamaUrl,
  stringifyWithInfinity,
  validateFourGroupCoinSelection,
  type FourGroupTradingBatch,
} from '@fadachi/core';
import type { DuckDBClient } from '../storage/duckdb.ts';

type DuckDBConnection = DuckDBClient;
import { abStorageTransaction } from './abStorage.ts';
import { AB_SERVICE_GENERATION, ensureABOwnership } from './abOwnership.ts';

const LEASE_TTL_MS = 15_000;
const ACTIVE_STATUSES = new Set(['RUNNING', 'PAUSED', 'DRAINING']);

export type FourGroupStorageErrorCode =
  | 'LEASE_MISSING'
  | 'LEASE_GENERATION_MISMATCH'
  | 'LEASE_TAKEN_OVER'
  | 'LEASE_EXPIRED'
  | 'INVALID_PAYLOAD'
  | 'LOCKED_IMMUTABLE'
  | 'DECISION_IMMUTABLE'
  | 'REVISION_CONFLICT'
  | 'DUPLICATE_DECISION_ID'
  | 'NOT_FOUND'
  | 'STORAGE_ERROR';

export interface FourGroupStorageErrorDetails {
  code?: FourGroupStorageErrorCode;
  batchId?: string;
  serverTime?: number;
  expiresAt?: number | null;
  generation?: string;
}

export class FourGroupStorageError extends Error {
  readonly statusCode: number;
  readonly code?: FourGroupStorageErrorCode;
  readonly batchId?: string;
  readonly serverTime?: number;
  readonly expiresAt?: number | null;
  readonly generation?: string;

  constructor(statusCode: number, message: string, details: FourGroupStorageErrorDetails = {}) {
    super(message);
    this.name = 'FourGroupStorageError';
    this.statusCode = statusCode;
    this.code = details.code;
    this.batchId = details.batchId;
    this.serverTime = details.serverTime;
    this.expiresAt = details.expiresAt;
    this.generation = details.generation;
  }
}

export async function ensureFourGroupSchema(connection: DuckDBConnection | DuckDBClient): Promise<void> {
  await connection.exec(`
    CREATE TABLE IF NOT EXISTS four_group_trading_batches (
      id VARCHAR PRIMARY KEY,
      market VARCHAR NOT NULL,
      status VARCHAR NOT NULL,
      revision INTEGER NOT NULL,
      ollama_url VARCHAR NOT NULL,
      model VARCHAR NOT NULL,
      prompt_version VARCHAR NOT NULL,
      rule_version VARCHAR NOT NULL,
      lgbm_policy_version VARCHAR NOT NULL,
      started_at BIGINT NOT NULL,
      ended_at BIGINT,
      updated_at BIGINT NOT NULL,
      batch_json VARCHAR NOT NULL
    );
    CREATE TABLE IF NOT EXISTS four_group_decisions (
      id VARCHAR PRIMARY KEY,
      batch_id VARCHAR NOT NULL,
      plan_id VARCHAR NOT NULL,
      symbol VARCHAR NOT NULL,
      side VARCHAR NOT NULL,
      confirmed_at BIGINT NOT NULL,
      lgbm_snapshot_id VARCHAR,
      lgbm_allowed BOOLEAN NOT NULL,
      lgbm_reason VARCHAR NOT NULL,
      ai_snapshot_id VARCHAR,
      ai_direction VARCHAR,
      ai_allowed BOOLEAN NOT NULL,
      ai_reason VARCHAR NOT NULL,
      allowed_a BOOLEAN NOT NULL,
      allowed_b BOOLEAN NOT NULL,
      allowed_c BOOLEAN NOT NULL,
      allowed_d BOOLEAN NOT NULL,
      decision_json VARCHAR NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS four_group_leases (
      batch_id VARCHAR PRIMARY KEY,
      owner_token VARCHAR NOT NULL,
      generation VARCHAR NOT NULL,
      lease_expires_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS four_group_batches_market_idx ON four_group_trading_batches(market, started_at DESC);
    CREATE INDEX IF NOT EXISTS four_group_decisions_batch_idx ON four_group_decisions(batch_id, confirmed_at ASC);
  `);
}

function hydrateBatchRow(row: {
  id: string;
  market: string;
  status: string;
  revision: number;
  model: string;
  batch_json: string;
  ownerActive?: boolean;
}) {
  const parsed = restoreInfinityInOrders(parseWithInfinity<FourGroupTradingBatch>(row.batch_json));
  return {
    id: row.id,
    market: row.market,
    status: row.status,
    revision: Number(row.revision),
    model: row.model,
    ownerActive: Boolean(row.ownerActive),
    batch: parsed,
  };
}

export function reconcileBatchToInterrupted(
  batch: FourGroupTradingBatch,
  now: number,
  reason: string,
): FourGroupTradingBatch {
  const next = restoreInfinityInOrders(structuredClone(batch));
  next.status = 'INTERRUPTED';
  next.endedAt = next.endedAt ?? now;
  next.reason = reason;
  next.revision = Number.isSafeInteger(next.revision) ? next.revision + 1 : 1;

  for (const id of FOUR_GROUP_IDS) {
    const acct = next.accounts[id];
    if (!acct) continue;
    if (ACTIVE_STATUSES.has(acct.status)) {
      acct.status = 'INTERRUPTED';
      acct.endedAt = acct.endedAt ?? now;
      acct.reason = reason;
    }
    for (const pos of acct.positions ?? []) {
      pos.incomplete = true;
    }
    acct.orders = [];
    acct.events = [...(acct.events ?? []), {
      id: `reconcile-${now}-${id}`,
      timestamp: now,
      type: 'INTERRUPTED',
      message: `${reason}；未完成持倉保留最後可靠估值，不補造平倉`,
    }];
  }
  return next;
}

export class FourGroupBatchRepository {
  private readonly client: DuckDBClient;
  private readonly tx: ReturnType<typeof abStorageTransaction>;
  private readonly clock: () => number;
  private schemaReady = false;
  private prevGenReconciled = false;
  private startupReconcilePromise: Promise<void> | null = null;

  constructor(client: DuckDBClient, clock: () => number = Date.now) {
    this.client = client;
    this.tx = abStorageTransaction(client);
    this.clock = clock;
  }

  private async ensureReady(connection: DuckDBConnection) {
    if (this.schemaReady) return;
    await ensureABOwnership(connection);
    await ensureFourGroupSchema(connection);
    this.schemaReady = true;
  }

  private async ensureStartupReconciled() {
    if (this.prevGenReconciled) return;
    if (!this.startupReconcilePromise) {
      this.startupReconcilePromise = (async () => {
        try {
          await this.reconcileOrphanedBatches({ onlyPreviousGeneration: true });
          this.prevGenReconciled = true;
        } finally {
          this.startupReconcilePromise = null;
        }
      })();
    }
    await this.startupReconcilePromise;
  }

  private async inspectLease(
    connection: DuckDBConnection,
    batchId: string,
    ownerToken: string,
    generation: string,
    now: number,
  ): Promise<number> {
    const rows = await connection.all<{ owner_token: string; generation: string; lease_expires_at: number }>(
      'SELECT owner_token, generation, lease_expires_at FROM four_group_leases WHERE batch_id = ?;',
      batchId,
    );
    if (!rows.length) {
      throw new FourGroupStorageError(409, '四組策略批次租約不存在或已回收', {
        code: 'LEASE_MISSING',
        batchId,
        serverTime: now,
        expiresAt: null,
        generation: AB_SERVICE_GENERATION,
      });
    }
    const row = rows[0];
    const rowExpiresAt = Number(row.lease_expires_at);
    if (!generation || generation !== AB_SERVICE_GENERATION || row.generation !== AB_SERVICE_GENERATION) {
      throw new FourGroupStorageError(409, 'Collector 已重啟（generation 變更），舊頁面租約已失效', {
        code: 'LEASE_GENERATION_MISMATCH',
        batchId,
        serverTime: now,
        expiresAt: rowExpiresAt,
        generation: AB_SERVICE_GENERATION,
      });
    }
    if (!ownerToken || row.owner_token !== ownerToken) {
      throw new FourGroupStorageError(409, '四組策略批次已由其他頁面持有或 token 不符', {
        code: 'LEASE_TAKEN_OVER',
        batchId,
        serverTime: now,
        expiresAt: rowExpiresAt,
        generation: AB_SERVICE_GENERATION,
      });
    }
    if (rowExpiresAt <= now) {
      throw new FourGroupStorageError(409, '四組策略批次 owner lease 已逾期，需先對帳恢復', {
        code: 'LEASE_EXPIRED',
        batchId,
        serverTime: now,
        expiresAt: rowExpiresAt,
        generation: AB_SERVICE_GENERATION,
      });
    }
    return rowExpiresAt;
  }

  private async reconcileOrphanedInTx(
    connection: DuckDBConnection,
    execNow: number,
    options: { market?: string; batchId?: string; onlyPreviousGeneration?: boolean } = {},
  ): Promise<string[]> {
    const clauses = ["b.status IN ('RUNNING', 'PAUSED', 'DRAINING')"];
    const params: unknown[] = [];
    if (options.market) {
      clauses.push('b.market = ?');
      params.push(options.market);
    }
    if (options.batchId) {
      clauses.push('b.id = ?');
      params.push(options.batchId);
    }
    const rows = await connection.all<{
      id: string;
      status: string;
      revision: number;
      batch_json: string;
      lease_generation: string | null;
      lease_expires_at: number | null;
    }>(
      `SELECT b.id, b.status, b.revision, b.batch_json,
              l.generation AS lease_generation, l.lease_expires_at AS lease_expires_at
       FROM four_group_trading_batches b
       LEFT JOIN four_group_leases l ON l.batch_id = b.id
       WHERE ${clauses.join(' AND ')};`,
      ...params,
    );

    const reconciledIds: string[] = [];
    for (const row of rows) {
      const genMatches = row.lease_generation === AB_SERVICE_GENERATION;
      const leaseLive = genMatches && Number(row.lease_expires_at) > execNow;
      if (leaseLive) continue;
      if (options.onlyPreviousGeneration && genMatches) continue;

      const parsed = restoreInfinityInOrders(parseWithInfinity<FourGroupTradingBatch>(row.batch_json));
      const reason = !row.lease_generation || !genMatches
        ? 'Collector 已重啟或租約代次失效，系統自動對帳為已中斷'
        : '四組策略批次 owner lease 已逾期且失去執行者，系統自動對帳為已中斷';
      const reconciled = reconcileBatchToInterrupted(parsed, execNow, reason);
      await connection.run(
        `UPDATE four_group_trading_batches
         SET status = ?, revision = ?, ended_at = ?, updated_at = ?, batch_json = ?
         WHERE id = ?;`,
        reconciled.status,
        reconciled.revision,
        reconciled.endedAt ?? execNow,
        execNow,
        stringifyWithInfinity(reconciled),
        row.id,
      );
      await connection.run('DELETE FROM four_group_leases WHERE batch_id = ?;', row.id);
      reconciledIds.push(row.id);
    }
    return reconciledIds;
  }

  async reconcileOrphanedBatches(options: {
    market?: string;
    batchId?: string;
    onlyPreviousGeneration?: boolean;
    now?: number;
  } = {}) {
    return this.tx(async (connection) => {
      await this.ensureReady(connection);
      const execNow = options.now ?? this.clock();
      const reconciledIds = await this.reconcileOrphanedInTx(connection, execNow, options);
      if (!options.batchId) {
        this.prevGenReconciled = true;
      }
      return {
        reconciledIds,
        serverTime: execNow,
        generation: AB_SERVICE_GENERATION,
      };
    });
  }

  async list(market?: string, limit = 50) {
    await this.ensureStartupReconciled();
    const now = this.clock();
    const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = market
      ? await this.client.all<any>(
        `SELECT b.id, b.market, b.status, b.revision, b.model, b.batch_json,
                (l.generation = ? AND l.lease_expires_at > ?) AS ownerActive
         FROM four_group_trading_batches b
         LEFT JOIN four_group_leases l ON l.batch_id = b.id
         WHERE b.market = ?
         ORDER BY b.started_at DESC
         LIMIT ?;`,
        AB_SERVICE_GENERATION, now, market, bounded,
      )
      : await this.client.all<any>(
        `SELECT b.id, b.market, b.status, b.revision, b.model, b.batch_json,
                (l.generation = ? AND l.lease_expires_at > ?) AS ownerActive
         FROM four_group_trading_batches b
         LEFT JOIN four_group_leases l ON l.batch_id = b.id
         ORDER BY b.started_at DESC
         LIMIT ?;`,
        AB_SERVICE_GENERATION, now, bounded,
      );
    return rows.map(hydrateBatchRow);
  }

  async getById(batchId: string) {
    await this.ensureStartupReconciled();
    const now = this.clock();
    const rows = await this.client.all<any>(
      `SELECT b.id, b.market, b.status, b.revision, b.model, b.batch_json,
              (l.generation = ? AND l.lease_expires_at > ?) AS ownerActive
       FROM four_group_trading_batches b
       LEFT JOIN four_group_leases l ON l.batch_id = b.id
       WHERE b.id = ?;`,
      AB_SERVICE_GENERATION, now, batchId,
    );
    if (!rows.length) return null;
    return hydrateBatchRow(rows[0]);
  }

  async claim(batchId: string, now?: number) {
    const enqueuedAt = this.clock();
    return this.tx(async (connection) => {
      await this.ensureReady(connection);
      const execNow = now ?? this.clock();

      const leaseRows = await connection.all<{ owner_token: string; generation: string; lease_expires_at: number }>(
        'SELECT owner_token, generation, lease_expires_at FROM four_group_leases WHERE batch_id = ?;',
        batchId,
      );

      if (leaseRows.length && leaseRows[0].generation === AB_SERVICE_GENERATION && Number(leaseRows[0].lease_expires_at) > execNow) {
        const batchRows = await connection.all<any>(
          'SELECT id, market, status, revision, model, batch_json FROM four_group_trading_batches WHERE id = ?;',
          batchId,
        );
        const batch = batchRows.length ? hydrateBatchRow(batchRows[0]).batch : undefined;
        return {
          owner: false as const,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
          expiresAt: Number(leaseRows[0].lease_expires_at),
          queueWaitMs: Math.max(0, execNow - enqueuedAt),
          batch,
        };
      }

      // No active valid owner holds this batch -> reconcile any stale active status cleanly before handing over
      await this.reconcileOrphanedInTx(connection, execNow, { batchId });

      const batchRows = await connection.all<any>(
        'SELECT id, market, status, revision, model, batch_json FROM four_group_trading_batches WHERE id = ?;',
        batchId,
      );
      const batch = batchRows.length ? hydrateBatchRow(batchRows[0]).batch : undefined;

      const ownerToken = randomUUID();
      const expiresAt = execNow + LEASE_TTL_MS;
      await connection.run(
        `INSERT OR REPLACE INTO four_group_leases (batch_id, owner_token, generation, lease_expires_at)
         VALUES (?, ?, ?, ?);`,
        batchId, ownerToken, AB_SERVICE_GENERATION, expiresAt,
      );

      return {
        owner: true as const,
        ownerToken,
        generation: AB_SERVICE_GENERATION,
        serverTime: execNow,
        expiresAt,
        queueWaitMs: Math.max(0, execNow - enqueuedAt),
        batch,
      };
    });
  }

  async renewLease(batchId: string, ownerToken: string, generation: string, now?: number) {
    const enqueuedAt = this.clock();
    return this.tx(async (connection) => {
      await this.ensureReady(connection);
      const execNow = now ?? this.clock();

      const prevExpiresAt = await this.inspectLease(connection, batchId, ownerToken, generation, execNow);
      const expiresAt = Math.max(prevExpiresAt, execNow + LEASE_TTL_MS);
      await connection.run(
        'UPDATE four_group_leases SET lease_expires_at = ? WHERE batch_id = ?;',
        expiresAt, batchId,
      );
      return {
        ok: true,
        id: batchId,
        serverTime: execNow,
        expiresAt,
        generation: AB_SERVICE_GENERATION,
        queueWaitMs: Math.max(0, execNow - enqueuedAt),
        elapsedMs: Math.max(0, this.clock() - execNow),
      };
    });
  }

  private sanitizeAndValidateBatch(batch: FourGroupTradingBatch): FourGroupTradingBatch {
    if (!batch || batch.marketType !== 'futures') {
      throw new FourGroupStorageError(400, '四組策略比較僅支援 USDT 永續合約（futures）');
    }
    if (!Number.isSafeInteger(batch.revision) || batch.revision < 0
      || !['RUNNING', 'PAUSED', 'DRAINING', 'COMPLETED', 'INTERRUPTED'].includes(batch.status)
      || batch.schemaVersion !== 1 || batch.strategyVersion !== 'four-group-futures-v1'
      || !Number.isSafeInteger(batch.startedAt) || batch.startedAt < 0
      || batch.config?.marketType !== 'futures' || !Array.isArray(batch.decisions)) {
      throw new FourGroupStorageError(400, '四組策略批次版本、狀態或資料結構無效');
    }
    if (!batch.locked) {
      throw new FourGroupStorageError(400, '四組策略批次缺少鎖定設定（locked）');
    }
    let cleanUrl: string;
    try {
      cleanUrl = sanitizeOllamaUrl(batch.locked.ollamaUrl);
      const { selectedCoins: normSelected } = validateFourGroupCoinSelection(
        batch.locked.selectedCoins,
        batch.locked.universeSymbols,
      );
      const locked = batch.locked;
      if (locked.coinMode !== undefined && locked.coinMode !== 'auto-lgbm' && locked.coinMode !== 'manual') {
        throw new FourGroupStorageError(400, '四組策略追蹤幣池模式無效');
      }
      const effectiveMode = locked.coinMode ?? 'manual';
      if (batch.activeCoins !== undefined) {
        const { selectedCoins: normActive } = validateFourGroupCoinSelection(
          batch.activeCoins,
          batch.locked.universeSymbols,
        );
        if (effectiveMode !== 'auto-lgbm' && JSON.stringify(normActive) !== JSON.stringify(normSelected)) {
          throw new FourGroupStorageError(409, '手動固定幣池模式禁止修改追蹤幣種');
        }
      }
      if (batch.coinRotations !== undefined) {
        if (!Array.isArray(batch.coinRotations)) {
          throw new FourGroupStorageError(400, '四組策略動態幣池輪替紀錄格式無效');
        }
        if (effectiveMode !== 'auto-lgbm' && batch.coinRotations.length > 0) {
          throw new FourGroupStorageError(409, '手動固定幣池模式禁止寫入動態輪替紀錄');
        }
        let prevCutoff = -Infinity;
        for (const rot of batch.coinRotations) {
          if (!rot || !Number.isFinite(rot.cutoffTime) || typeof rot.snapshotId !== 'string'
            || !rot.snapshotId.trim() || !Number.isFinite(rot.updatedAt) || !Array.isArray(rot.coins)
            || rot.cutoffTime < prevCutoff) {
            throw new FourGroupStorageError(400, '四組策略動態幣池輪替項目結構無效');
          }
          validateFourGroupCoinSelection(rot.coins, batch.locked.universeSymbols);
          prevCutoff = rot.cutoffTime;
        }
      }
      if (locked.topK !== LGBM_RANK_TOP_K || !Number.isFinite(locked.aiTtlMs)
        || locked.aiTtlMs <= 0 || locked.aiTtlMs > SNAPSHOT_VALIDITY_MS
        || locked.isRemoteOllama !== isRemoteOllamaUrl(cleanUrl)
        || ![locked.model, locked.promptVersion, locked.ruleVersion, locked.lgbmPolicyVersion]
          .every(value => typeof value === 'string' && value.trim().length > 0)) {
        throw new FourGroupStorageError(409, '四組策略鎖定模型或門禁參數無效');
      }
    } catch (err: any) {
      if (err instanceof FourGroupStorageError) throw err;
      throw new FourGroupStorageError(400, err?.message || '四組策略鎖定設定無效');
    }

    for (const id of FOUR_GROUP_IDS) {
      const account = batch.accounts?.[id];
      if (!account || account.marketType !== 'futures'
        || !Array.isArray(account.orders) || !Array.isArray(account.fills)
        || !Array.isArray(account.positions) || !Array.isArray(account.trades)
        || !Array.isArray(account.equity) || !Array.isArray(account.events)) {
        throw new FourGroupStorageError(400, `四組策略批次缺少帳戶 ${id} 狀態`);
      }
    }
    const decisionIds = new Set<string>();
    const planIds = new Set<string>();
    for (const dec of batch.decisions) {
      if (!dec?.id || !dec.planId || decisionIds.has(dec.id) || planIds.has(dec.planId)
        || !Number.isSafeInteger(dec.confirmedAt) || !Number.isSafeInteger(dec.receivedAt)
        || dec.confirmedAt > dec.receivedAt || !dec.lgbm || !dec.ai
        || !FOUR_GROUP_IDS.every(id => typeof dec.groups?.[id]?.allowed === 'boolean')) {
        throw new FourGroupStorageError(400, '四組策略決策紀錄結構無效或重複');
      }
      decisionIds.add(dec.id);
      planIds.add(dec.planId);
    }

    return restoreInfinityInOrders(
      parseWithInfinity<FourGroupTradingBatch>(stringifyWithInfinity({
        ...batch,
        locked: {
          ...batch.locked,
          ollamaUrl: cleanUrl,
        },
      })),
    );
  }

  private async persistValidatedInTx(
    connection: DuckDBConnection,
    sanitizedBatch: FourGroupTradingBatch,
    execNow: number,
    enqueuedAt: number,
    txStart: number,
    validateNewUniverse?: (universeSymbols: string[]) => void,
  ) {
    const existingRows = await connection.all<{ revision: number; batch_json: string }>(
      'SELECT revision, batch_json FROM four_group_trading_batches WHERE id = ?;',
      sanitizedBatch.id,
    );

    let prevDecCount = 0;
    if (existingRows.length === 0 && validateNewUniverse) {
      validateNewUniverse(sanitizedBatch.locked.universeSymbols);
    } else if (existingRows.length > 0) {
      const existingRev = Number(existingRows[0].revision);
      if (sanitizedBatch.revision < existingRev) {
        throw new FourGroupStorageError(409, `版本衝突：儲存版本 (${sanitizedBatch.revision}) 落後目前版本 (${existingRev})`, {
          code: 'REVISION_CONFLICT',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      const prev = parseWithInfinity<FourGroupTradingBatch>(existingRows[0].batch_json);
      if (sanitizedBatch.revision === existingRev
        && stringifyWithInfinity(prev) !== stringifyWithInfinity(sanitizedBatch)) {
        throw new FourGroupStorageError(409, '版本衝突：同一版本不可覆寫不同內容', {
          code: 'REVISION_CONFLICT',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      // Locked settings, startedAt, and previously persisted decisions must never be mutated
      const lockedSame =
        prev.startedAt === sanitizedBatch.startedAt
        && stringifyWithInfinity(prev.config) === stringifyWithInfinity(sanitizedBatch.config)
        && prev.locked.topK === sanitizedBatch.locked.topK
        && prev.locked.aiTtlMs === sanitizedBatch.locked.aiTtlMs
        && prev.locked.isRemoteOllama === sanitizedBatch.locked.isRemoteOllama
        && prev.locked.ollamaUrl === sanitizedBatch.locked.ollamaUrl
        && prev.locked.model === sanitizedBatch.locked.model
        && prev.locked.promptVersion === sanitizedBatch.locked.promptVersion
        && prev.locked.ruleVersion === sanitizedBatch.locked.ruleVersion
        && prev.locked.lgbmPolicyVersion === sanitizedBatch.locked.lgbmPolicyVersion
        && (prev.locked.coinMode ?? 'manual') === (sanitizedBatch.locked.coinMode ?? 'manual')
        && JSON.stringify(prev.locked.selectedCoins) === JSON.stringify(sanitizedBatch.locked.selectedCoins)
        && JSON.stringify(prev.locked.universeSymbols) === JSON.stringify(sanitizedBatch.locked.universeSymbols);
      const accountConfigsSame = FOUR_GROUP_IDS.every(id =>
        stringifyWithInfinity(prev.accounts[id].config) === stringifyWithInfinity(sanitizedBatch.accounts[id].config)
        && stringifyWithInfinity(prev.accounts[id].signalSettings) === stringifyWithInfinity(sanitizedBatch.accounts[id].signalSettings));
      if (!lockedSame || !accountConfigsSame) {
        throw new FourGroupStorageError(409, '執行中的四組批次禁止更改已鎖定模型、Ollama 端點、規則版本或追蹤幣池', {
          code: 'LOCKED_IMMUTABLE',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      prevDecCount = prev.decisions?.length ?? 0;
      if ((sanitizedBatch.decisions?.length ?? 0) < prevDecCount) {
        throw new FourGroupStorageError(409, '四組策略決策紀錄只可附加，不可刪除或竄改既有決策', {
          code: 'DECISION_IMMUTABLE',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      for (let i = 0; i < prevDecCount; i++) {
        if (JSON.stringify(prev.decisions[i]) !== JSON.stringify(sanitizedBatch.decisions[i])) {
          throw new FourGroupStorageError(409, `既有決策紀錄索引 ${i} 遭到修改，已拒絕覆寫`, {
            code: 'DECISION_IMMUTABLE',
            batchId: sanitizedBatch.id,
            serverTime: execNow,
            generation: AB_SERVICE_GENERATION,
          });
        }
      }
      const prevRotations = prev.coinRotations ?? [];
      const nextRotations = sanitizedBatch.coinRotations ?? [];
      if (nextRotations.length < prevRotations.length) {
        throw new FourGroupStorageError(409, '四組策略動態幣池輪替紀錄只可附加，不可刪除或竄改', {
          code: 'LOCKED_IMMUTABLE',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      for (let i = 0; i < prevRotations.length; i++) {
        if (JSON.stringify(prevRotations[i]) !== JSON.stringify(nextRotations[i])) {
          throw new FourGroupStorageError(409, `既有動態幣池輪替紀錄索引 ${i} 遭到修改，已拒絕覆寫`, {
            code: 'LOCKED_IMMUTABLE',
            batchId: sanitizedBatch.id,
            serverTime: execNow,
            generation: AB_SERVICE_GENERATION,
          });
        }
      }
    }

    const batchJson = stringifyWithInfinity(sanitizedBatch);
    await connection.run(
      `INSERT OR REPLACE INTO four_group_trading_batches
       (id, market, status, revision, ollama_url, model, prompt_version, rule_version, lgbm_policy_version, started_at, ended_at, updated_at, batch_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      sanitizedBatch.id,
      sanitizedBatch.marketType,
      sanitizedBatch.status,
      sanitizedBatch.revision,
      sanitizedBatch.locked.ollamaUrl,
      sanitizedBatch.locked.model,
      sanitizedBatch.locked.promptVersion,
      sanitizedBatch.locked.ruleVersion,
      sanitizedBatch.locked.lgbmPolicyVersion,
      sanitizedBatch.startedAt,
      sanitizedBatch.endedAt ?? null,
      execNow,
      batchJson,
    );

    // Incrementally write ONLY newly appended decisions since prior persisted revision
    const newDecisions = (sanitizedBatch.decisions ?? []).slice(prevDecCount);
    for (const dec of newDecisions) {
      const prior = await connection.all<{ batch_id: string }>(
        'SELECT batch_id FROM four_group_decisions WHERE id = ?;', dec.id,
      );
      if (prior.length && prior[0].batch_id !== sanitizedBatch.id) {
        throw new FourGroupStorageError(409, '決策 ID 已由另一四組策略批次使用', {
          code: 'DUPLICATE_DECISION_ID',
          batchId: sanitizedBatch.id,
          serverTime: execNow,
          generation: AB_SERVICE_GENERATION,
        });
      }
      await connection.run(
        `INSERT OR IGNORE INTO four_group_decisions
         (id, batch_id, plan_id, symbol, side, confirmed_at, lgbm_snapshot_id, lgbm_allowed, lgbm_reason, ai_snapshot_id, ai_direction, ai_allowed, ai_reason, allowed_a, allowed_b, allowed_c, allowed_d, decision_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        dec.id,
        sanitizedBatch.id,
        dec.planId,
        dec.symbol,
        dec.side,
        dec.confirmedAt,
        dec.lgbm.snapshotId,
        dec.lgbm.allowed,
        dec.lgbm.reason,
        dec.ai.snapshotId,
        dec.ai.direction,
        dec.ai.allowed,
        dec.ai.reason,
        dec.groups.A.allowed,
        dec.groups.B.allowed,
        dec.groups.C.allowed,
        dec.groups.D.allowed,
        JSON.stringify(dec),
        execNow,
      );
    }

    const finishedAt = this.clock();
    return {
      ok: true,
      id: sanitizedBatch.id,
      revision: sanitizedBatch.revision,
      serverTime: execNow,
      generation: AB_SERVICE_GENERATION,
      writtenDecisions: newDecisions.length,
      queueWaitMs: Math.max(0, txStart - enqueuedAt),
      txElapsedMs: Math.max(0, finishedAt - txStart),
      batchBytes: Buffer.byteLength(batchJson, 'utf8'),
    };
  }

  /**
   * Direct backend persistence used by FourGroupService running inside Collector.
   * No browser write-lease check is needed because Collector is the single authoritative writer.
   */
  async saveSystemBatch(
    batch: FourGroupTradingBatch,
    options?: { now?: number; validateNewUniverse?: (universeSymbols: string[]) => void },
  ) {
    await this.ensureStartupReconciled();
    const sanitizedBatch = this.sanitizeAndValidateBatch(batch);
    const enqueuedAt = this.clock();
    return this.tx(async (connection) => {
      await this.ensureReady(connection);
      const txStart = this.clock();
      const execNow = options?.now ?? txStart;
      return this.persistValidatedInTx(
        connection,
        sanitizedBatch,
        execNow,
        enqueuedAt,
        txStart,
        options?.validateNewUniverse,
      );
    });
  }

  async save(payload: {
    id: string;
    market: string;
    status: string;
    revision: number;
    batch: FourGroupTradingBatch;
    ownerToken: string;
    generation: string;
  }, optionsOrNow?: number | { now?: number; validateNewUniverse?: (universeSymbols: string[]) => void }) {
    const now = typeof optionsOrNow === 'number' ? optionsOrNow : optionsOrNow?.now;
    const validateNewUniverse = typeof optionsOrNow === 'object' && optionsOrNow !== null
      ? optionsOrNow.validateNewUniverse
      : undefined;
    if (payload.market !== 'futures' || payload.batch?.marketType !== 'futures') {
      throw new FourGroupStorageError(400, '四組策略比較僅支援 USDT 永續合約（futures）');
    }
    if (!payload.batch || payload.batch.id !== payload.id) {
      throw new FourGroupStorageError(400, 'batch.id 與請求 id 不一致');
    }
    if (payload.revision !== payload.batch.revision || payload.status !== payload.batch.status) {
      throw new FourGroupStorageError(400, '四組策略批次版本、狀態或資料結構無效');
    }
    const sanitizedBatch = this.sanitizeAndValidateBatch(payload.batch);

    const enqueuedAt = this.clock();
    return this.tx(async (connection) => {
      await this.ensureReady(connection);
      const txStart = this.clock();
      const execNow = now ?? txStart;

      const prevExpiresAt = await this.inspectLease(connection, payload.id, payload.ownerToken, payload.generation, execNow);
      const result = await this.persistValidatedInTx(
        connection,
        sanitizedBatch,
        execNow,
        enqueuedAt,
        txStart,
        validateNewUniverse,
      );

      // Auto-renew lease cleanly without ever regressing expiresAt
      const expiresAt = Math.max(prevExpiresAt, execNow + LEASE_TTL_MS);
      await connection.run(
        'UPDATE four_group_leases SET lease_expires_at = ? WHERE batch_id = ?;',
        expiresAt,
        sanitizedBatch.id,
      );

      return {
        ...result,
        expiresAt,
      };
    });
  }
}
