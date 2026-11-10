"""
Demonstration script for querying Fadachi aggTrades and alert_events from DuckDB and Parquet.

Usage:
  python 01_load_aggtrades.py
"""
import duckdb
import os

DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))
PARQUET_GLOB = os.path.join(DATA_DIR, "parquet", "aggtrades", "**", "*.parquet")
DB_PATH = os.path.join(DATA_DIR, "fadachi.duckdb")

def main():
    con = duckdb.connect()
    
    print("=== Checking Parquet files ===")
    try:
        df_trades = con.sql(f"SELECT * FROM '{PARQUET_GLOB}' LIMIT 10").df()
        print(df_trades)
    except Exception as e:
        print(f"No parquet files loaded or error: {e}")

    print("\n=== Checking DuckDB database ===")
    if os.path.exists(DB_PATH):
        db_con = duckdb.connect(DB_PATH, read_only=True)
        print("Tables in DuckDB:")
        print(db_con.sql("SHOW TABLES;").df())
    else:
        print(f"Database at {DB_PATH} does not exist yet (start collector first).")

if __name__ == "__main__":
    main()
