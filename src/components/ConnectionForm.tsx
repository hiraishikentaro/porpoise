import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { type ConnectionConfig, testConnection } from "@/lib/tauri";

type Status =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; version: string }
  | { kind: "error"; message: string };

const defaultConfig: ConnectionConfig = {
  host: "127.0.0.1",
  port: 3307,
  user: "porpoise",
  password: "porpoise",
  database: "porpoise_dev",
  use_ssl: false,
};

export function ConnectionForm() {
  const [config, setConfig] = useState<ConnectionConfig>(defaultConfig);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function update<K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }

  async function handleTest() {
    setStatus({ kind: "pending" });
    try {
      const version = await testConnection({
        ...config,
        database: config.database?.trim() ? config.database.trim() : null,
      });
      setStatus({ kind: "ok", version });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>New connection</CardTitle>
        <CardDescription>MySQL サーバーに接続テストします。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="host">Host</Label>
            <Input
              id="host"
              value={config.host}
              onChange={(e) => update("host", e.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              value={config.port}
              onChange={(e) => update("port", Number(e.currentTarget.value) || 0)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="user">User</Label>
            <Input
              id="user"
              value={config.user}
              onChange={(e) => update("user", e.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={config.password}
              onChange={(e) => update("password", e.currentTarget.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="database">Database (optional)</Label>
          <Input
            id="database"
            value={config.database ?? ""}
            onChange={(e) => update("database", e.currentTarget.value)}
          />
        </div>

        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="flex flex-col">
            <Label htmlFor="ssl">Use SSL</Label>
            <span className="text-muted-foreground text-xs">
              サーバーが TLS をサポートしていれば有効化
            </span>
          </div>
          <Switch
            id="ssl"
            checked={config.use_ssl}
            onCheckedChange={(value) => update("use_ssl", value)}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={handleTest} disabled={status.kind === "pending"}>
            {status.kind === "pending" ? "Testing…" : "Test connection"}
          </Button>
          {status.kind === "ok" && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">
              OK — MySQL {status.version}
            </span>
          )}
          {status.kind === "error" && (
            <span className="text-destructive text-sm">{status.message}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
