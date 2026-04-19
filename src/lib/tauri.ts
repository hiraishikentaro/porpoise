import { invoke } from "@tauri-apps/api/core";

export type SslMode = "disabled" | "preferred" | "required" | "verify_ca" | "verify_identity";

export type SslConfigInput = {
  mode: SslMode;
  ca_cert_path: string | null;
  client_cert_path: string | null;
  client_key_path: string | null;
};

export type SshAuthInput =
  | { kind: "password"; password: string }
  | { kind: "key"; key_path: string; passphrase: string | null };

export type SshConfigInput = {
  host: string;
  port: number;
  user: string;
  auth: SshAuthInput;
};

export type ConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  ssl: SslConfigInput;
  ssh: SshConfigInput | null;
  enable_cleartext_plugin: boolean;
};

export type SaveConnectionInput = ConnectionConfig & {
  name: string;
  history_enabled: boolean;
  color_label: string | null;
};

export type SavedSslConfig = {
  mode: SslMode;
  ca_cert_path: string | null;
  client_cert_path: string | null;
  client_key_path: string | null;
};

export type SavedSshConfig = {
  host: string;
  port: number;
  user: string;
  auth_kind: "password" | "key";
  key_path: string | null;
};

export type SavedConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string | null;
  ssl: SavedSslConfig;
  ssh: SavedSshConfig | null;
  enable_cleartext_plugin: boolean;
  history_enabled: boolean;
  color_label: string | null;
  created_at: string;
  updated_at: string;
};

export function testConnection(config: ConnectionConfig): Promise<string> {
  return invoke<string>("test_connection", { config });
}

export function saveConnection(input: SaveConnectionInput): Promise<SavedConnection> {
  return invoke<SavedConnection>("save_connection", { input });
}

export type UpdateConnectionInput = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  /** 空文字なら keychain の既存パスワードを保持する */
  password: string | null;
  database: string | null;
  ssl: SslConfigInput;
  ssh: SshConfigInput | null;
  enable_cleartext_plugin: boolean;
  history_enabled: boolean;
  color_label: string | null;
};

export function updateConnection(input: UpdateConnectionInput): Promise<SavedConnection> {
  return invoke<SavedConnection>("update_connection", { input });
}

export function listConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("list_connections");
}

export function deleteConnection(id: string): Promise<void> {
  return invoke<void>("delete_connection", { id });
}

export type OpenConnectionResult = {
  id: string;
  version: string;
};

export function openConnection(id: string): Promise<OpenConnectionResult> {
  return invoke<OpenConnectionResult>("open_connection", { id });
}

export function closeConnection(id: string): Promise<void> {
  return invoke<void>("close_connection", { id });
}

export function activeConnections(): Promise<string[]> {
  return invoke<string[]>("active_connections");
}

export type TableKind = "table" | "view";
export type TableInfo = { name: string; kind: TableKind };
export type ColumnInfo = {
  name: string;
  data_type: string;
  nullable: boolean;
  key: string | null;
  default: string | null;
  extra: string | null;
  comment: string | null;
};

export function listDatabases(connectionId: string): Promise<string[]> {
  return invoke<string[]>("list_databases", { connectionId });
}

export function listTables(connectionId: string, database: string): Promise<TableInfo[]> {
  return invoke<TableInfo[]>("list_tables", { connectionId, database });
}

export type AllTablesEntry = {
  database: string;
  name: string;
  kind: TableKind;
};

export function listAllTables(connectionId: string): Promise<AllTablesEntry[]> {
  return invoke<AllTablesEntry[]>("list_all_tables", { connectionId });
}

export function describeTable(
  connectionId: string,
  database: string,
  table: string,
): Promise<ColumnInfo[]> {
  return invoke<ColumnInfo[]>("describe_table", { connectionId, database, table });
}

export type TablePage = {
  columns: string[];
  rows: (string | null)[][];
  offset: number;
  returned: number;
};

export type SortKey = {
  column: string;
  descending: boolean;
};

export type Filter =
  | {
      column: string;
      op: "eq" | "ne" | "lt" | "le" | "gt" | "ge" | "like" | "not_like";
      value: string;
    }
  | { column: string; op: "is_null" | "is_not_null" };

export type FilterMatch = "all" | "any";

export type SelectTableOptions = {
  sort?: SortKey[];
  filters?: Filter[];
  filterMatch?: FilterMatch;
};

export function selectTableRows(
  connectionId: string,
  database: string,
  table: string,
  offset: number,
  limit: number,
  opts: SelectTableOptions = {},
): Promise<TablePage> {
  return invoke<TablePage>("select_table_rows", {
    connectionId,
    database,
    table,
    offset,
    limit,
    sort: opts.sort ?? null,
    filters: opts.filters ?? null,
    filterMatch: opts.filterMatch ?? null,
  });
}

export type CellChange = {
  column: string;
  /** null は NULL を意味する */
  value: string | null;
};

export type RowChange =
  | {
      kind: "update";
      database: string;
      table: string;
      changes: CellChange[];
      pk: CellChange[];
    }
  | {
      kind: "insert";
      database: string;
      table: string;
      /** 明示的に設定する列。空配列なら全列 DEFAULT */
      values: CellChange[];
    }
  | {
      kind: "delete";
      database: string;
      table: string;
      pk: CellChange[];
    };

export type CommitChangesResult = {
  updated: number;
  inserted: number;
  deleted: number;
  statements: number;
};

export function commitChanges(
  connectionId: string,
  changes: RowChange[],
): Promise<CommitChangesResult> {
  return invoke<CommitChangesResult>("commit_changes", { connectionId, changes });
}

export type QueryResult =
  | {
      kind: "select";
      columns: string[];
      rows: (string | null)[][];
      returned: number;
      elapsed_ms: number;
    }
  | {
      kind: "affected";
      rows: number;
      elapsed_ms: number;
    };

export function executeQuery(
  connectionId: string,
  sql: string,
  database?: string | null,
  requestId?: string | null,
): Promise<QueryResult> {
  return invoke<QueryResult>("execute_query", {
    connectionId,
    sql,
    database: database ?? null,
    requestId: requestId ?? null,
  });
}

/** 実行中クエリを KILL QUERY で中断する。killed=true が返れば成功 */
export function cancelQuery(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_query", { requestId });
}

export type SchemaSnapshot = {
  /** table name → column names (ordinal order) */
  tables: Record<string, string[]>;
};

export function schemaSnapshot(connectionId: string, database: string): Promise<SchemaSnapshot> {
  return invoke<SchemaSnapshot>("schema_snapshot", { connectionId, database });
}

export type QueryHistoryRow = {
  id: number;
  connection_id: string;
  database: string | null;
  sql: string;
  /** RFC3339 */
  executed_at: string;
  duration_ms: number | null;
  row_count: number | null;
  error: string | null;
};

export type QueryHistoryList = { items: QueryHistoryRow[] };

export function listQueryHistory(opts: {
  connectionId?: string | null;
  search?: string | null;
  limit?: number | null;
}): Promise<QueryHistoryList> {
  return invoke<QueryHistoryList>("list_query_history", {
    connectionId: opts.connectionId ?? null,
    search: opts.search ?? null,
    limit: opts.limit ?? null,
  });
}

export function clearQueryHistory(connectionId: string | null): Promise<number> {
  return invoke<number>("clear_query_history", { connectionId });
}

export type SavedQuery = {
  id: number;
  connection_id: string;
  name: string;
  sql: string;
  created_at: string;
  updated_at: string;
};

export function saveSnippet(connectionId: string, name: string, sql: string): Promise<SavedQuery> {
  return invoke<SavedQuery>("save_snippet", { connectionId, name, sql });
}

export function updateSnippet(id: number, name: string, sql: string): Promise<SavedQuery> {
  return invoke<SavedQuery>("update_snippet", { id, name, sql });
}

export function listSnippets(connectionId: string): Promise<SavedQuery[]> {
  return invoke<SavedQuery[]>("list_snippets", { connectionId });
}

export function deleteSnippet(id: number): Promise<boolean> {
  return invoke<boolean>("delete_snippet", { id });
}

export type ExportFormat = "csv" | "json" | "sql";

export type ExportResult = {
  path: string;
  rows: number;
  bytes: number;
};

export function exportTable(args: {
  connectionId: string;
  database: string;
  table: string;
  sort?: SortKey[] | null;
  filters?: Filter[] | null;
  filterMatch?: FilterMatch | null;
  format: ExportFormat;
  path: string;
}): Promise<ExportResult> {
  return invoke<ExportResult>("export_table", {
    connectionId: args.connectionId,
    database: args.database,
    table: args.table,
    sort: args.sort ?? null,
    filters: args.filters ?? null,
    filterMatch: args.filterMatch ?? null,
    format: args.format,
    path: args.path,
  });
}

export type CsvPreview = {
  header: string[];
  rows: string[][];
  total_approx: number | null;
};

export function previewCsv(path: string, limit: number): Promise<CsvPreview> {
  return invoke<CsvPreview>("preview_csv", { path, limit });
}

export type ImportMode = "insert" | "upsert";

export type ColumnMapping = {
  target: string;
  csv_index: number | null;
};

export type ImportResult = {
  inserted: number;
  rows_read: number;
  dry_run: boolean;
  batches: number;
  warnings: string[];
};

export function importCsv(args: {
  connectionId: string;
  database: string;
  table: string;
  path: string;
  mapping: ColumnMapping[];
  mode: ImportMode;
  hasHeader: boolean;
  emptyAsNull: boolean;
  dryRun: boolean;
}): Promise<ImportResult> {
  return invoke<ImportResult>("import_csv", {
    connectionId: args.connectionId,
    database: args.database,
    table: args.table,
    path: args.path,
    mapping: args.mapping,
    mode: args.mode,
    hasHeader: args.hasHeader,
    emptyAsNull: args.emptyAsNull,
    dryRun: args.dryRun,
  });
}

export function exportQuery(args: {
  connectionId: string;
  database: string | null;
  sql: string;
  format: ExportFormat;
  path: string;
}): Promise<ExportResult> {
  return invoke<ExportResult>("export_query", {
    connectionId: args.connectionId,
    database: args.database,
    sql: args.sql,
    format: args.format,
    path: args.path,
  });
}
