import type { MarketType } from '@fadachi/core';
import type { DuckDBClient } from '../storage/duckdb.ts';
import { abStorageTransaction } from './abStorage.ts';

export interface AnalysisScope {
  market: MarketType;
  symbols: string[];
  model: string;
}

export interface AnalysisScopeState extends AnalysisScope {
  locked: boolean;
  lockOwner: string | null;
  needsConfiguration: boolean;
}

const DEFAULT_SCOPE: AnalysisScope = {
  market: 'futures', symbols: ['BTCUSDT', 'ETHUSDT'], model: '',
};

export class AIScopeStore {
  private readonly client: DuckDBClient;
  private readonly transaction: ReturnType<typeof abStorageTransaction>;
  private readonly initialScope: AnalysisScope;
  private initialized?: Promise<void>;

  constructor(client: DuckDBClient, initialScope: AnalysisScope = DEFAULT_SCOPE) {
    this.client = client;
    this.transaction = abStorageTransaction(client);
    this.initialScope = this.normalize(initialScope);
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.client.exec(`
      CREATE TABLE IF NOT EXISTS ai_scope_settings (
        singleton BOOLEAN PRIMARY KEY,
        market VARCHAR NOT NULL,
        symbols_json VARCHAR NOT NULL,
        model VARCHAR NOT NULL,
        lock_owner VARCHAR,
        updated_at BIGINT NOT NULL
      );
    `);
    await this.initialized;
    await this.transaction(async connection => {
      await connection.run(
        `INSERT INTO ai_scope_settings (singleton, market, symbols_json, model, lock_owner, updated_at)
         SELECT TRUE, ?, ?, ?, NULL, ? WHERE NOT EXISTS (SELECT 1 FROM ai_scope_settings WHERE singleton = TRUE);`,
        this.initialScope.market, JSON.stringify(this.initialScope.symbols), this.initialScope.model, Date.now(),
      );
    });
  }

  async getScope(): Promise<AnalysisScopeState> {
    await this.initialize();
    const rows = await this.client.all<any>(
      'SELECT market, symbols_json, model, lock_owner FROM ai_scope_settings WHERE singleton = TRUE;',
    );
    if (!rows.length) throw new Error('AI scope settings are missing');
    return {
      market: rows[0].market as MarketType,
      symbols: JSON.parse(rows[0].symbols_json) as string[],
      model: rows[0].model,
      locked: Boolean(rows[0].lock_owner),
      lockOwner: rows[0].lock_owner ?? null,
      needsConfiguration: !String(rows[0].model ?? '').trim(),
    };
  }

  async setScope(scope: AnalysisScope): Promise<AnalysisScopeState> {
    const normalized = this.normalize(scope);
    await this.initialize();
    await this.transaction(async connection => {
      const rows = await connection.all<{ lock_owner: string | null }>(
        'SELECT lock_owner FROM ai_scope_settings WHERE singleton = TRUE;',
      );
      if (rows[0]?.lock_owner) throw new Error(`AI scope is locked by ${rows[0].lock_owner}`);
      await connection.run(
        `UPDATE ai_scope_settings SET market = ?, symbols_json = ?, model = ?, updated_at = ? WHERE singleton = TRUE;`,
        normalized.market, JSON.stringify(normalized.symbols), normalized.model, Date.now(),
      );
    });
    return this.getScope();
  }

  async lockScope(owner: string): Promise<AnalysisScope> {
    if (!owner.trim()) throw new Error('Scope lock owner is required');
    await this.initialize();
    return this.transaction(async connection => {
      const rows = await connection.all<any>(
        'SELECT market, symbols_json, model, lock_owner FROM ai_scope_settings WHERE singleton = TRUE;',
      );
      const current = rows[0];
      if (current.lock_owner && current.lock_owner !== owner) throw new Error(`AI scope is locked by ${current.lock_owner}`);
      await connection.run(
        'UPDATE ai_scope_settings SET lock_owner = ?, updated_at = ? WHERE singleton = TRUE;', owner, Date.now(),
      );
      return {
        market: current.market as MarketType,
        symbols: JSON.parse(current.symbols_json) as string[],
        model: current.model,
      };
    });
  }

  async unlockScope(owner: string): Promise<void> {
    await this.initialize();
    await this.transaction(async connection => {
      const rows = await connection.all<{ lock_owner: string | null }>(
        'SELECT lock_owner FROM ai_scope_settings WHERE singleton = TRUE;',
      );
      if (rows[0]?.lock_owner !== owner) throw new Error('Only the scope lock owner may unlock it');
      await connection.run(
        'UPDATE ai_scope_settings SET lock_owner = NULL, updated_at = ? WHERE singleton = TRUE;', Date.now(),
      );
    });
  }

  private normalize(scope: AnalysisScope): AnalysisScope {
    if (scope.market !== 'spot' && scope.market !== 'futures') throw new Error('Invalid AI scope market');
    const symbols = [...new Set(scope.symbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean))];
    if (!symbols.length || symbols.length > 10 || symbols.some(symbol => !/^[A-Z0-9]{2,20}$/.test(symbol))) {
      throw new Error('AI scope must contain 1 to 10 valid symbols');
    }
    if (typeof scope.model !== 'string') throw new Error('AI scope model must be a string');
    return { market: scope.market, symbols, model: scope.model.trim() };
  }
}

export { AIScopeStore as ScopeStore };
