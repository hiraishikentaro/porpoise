import { invoke } from "@tauri-apps/api/core";

export type ConnectionConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string | null;
  use_ssl: boolean;
};

export async function testConnection(config: ConnectionConfig): Promise<string> {
  return invoke<string>("test_connection", { config });
}
