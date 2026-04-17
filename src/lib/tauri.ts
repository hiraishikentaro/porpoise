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
