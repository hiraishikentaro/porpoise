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

export type SaveConnectionInput = ConnectionConfig & { name: string };

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

export function selectTableRows(
  connectionId: string,
  database: string,
  table: string,
  offset: number,
  limit: number,
): Promise<TablePage> {
  return invoke<TablePage>("select_table_rows", {
    connectionId,
    database,
    table,
    offset,
    limit,
  });
}

export type CellChange = {
  column: string;
  /** null は NULL を意味する */
  value: string | null;
};

export type RowEdit = {
  database: string;
  table: string;
  changes: CellChange[];
  pk: CellChange[];
};

export type CommitEditsResult = {
  affected_rows: number;
  statements: number;
};

export function commitEdits(connectionId: string, edits: RowEdit[]): Promise<CommitEditsResult> {
  return invoke<CommitEditsResult>("commit_edits", { connectionId, edits });
}
