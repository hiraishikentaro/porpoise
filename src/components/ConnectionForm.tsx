import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  type ConnectionConfig,
  type SavedConnection,
  saveConnection,
  testConnection,
} from "@/lib/tauri";

type FormValues = {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  use_ssl: boolean;
};

type Status =
  | { kind: "idle" }
  | { kind: "pending"; action: "test" | "save" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

const defaultValues: FormValues = {
  name: "",
  host: "127.0.0.1",
  port: 3307,
  user: "porpoise",
  password: "porpoise",
  database: "porpoise_dev",
  use_ssl: false,
};

type Props = {
  initial: SavedConnection | null;
  onSaved: (conn: SavedConnection) => void;
};

export function ConnectionForm({ initial, onSaved }: Props) {
  const [values, setValues] = useState<FormValues>(defaultValues);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  useEffect(() => {
    if (initial) {
      setValues({
        name: initial.name,
        host: initial.host,
        port: initial.port,
        user: initial.user,
        password: "",
        database: initial.database ?? "",
        use_ssl: initial.use_ssl,
      });
      setStatus({ kind: "idle" });
    }
  }, [initial]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function toConfig(): ConnectionConfig {
    return {
      host: values.host,
      port: values.port,
      user: values.user,
      password: values.password,
      database: values.database.trim() ? values.database.trim() : null,
      use_ssl: values.use_ssl,
    };
  }

  async function handleTest() {
    setStatus({ kind: "pending", action: "test" });
    try {
      const version = await testConnection(toConfig());
      setStatus({ kind: "ok", message: `OK — MySQL ${version}` });
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }

  async function handleSave() {
    if (!values.name.trim()) {
      setStatus({ kind: "error", message: "Name is required to save a connection." });
      return;
    }
    setStatus({ kind: "pending", action: "save" });
    try {
      const saved = await saveConnection({
        name: values.name.trim(),
        host: values.host,
        port: values.port,
        user: values.user,
        password: values.password,
        database: values.database.trim() ? values.database.trim() : null,
        use_ssl: values.use_ssl,
      });
      setStatus({ kind: "ok", message: `Saved "${saved.name}"` });
      onSaved(saved);
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }

  const testing = status.kind === "pending" && status.action === "test";
  const saving = status.kind === "pending" && status.action === "save";

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>{initial ? `Edit: ${initial.name}` : "New connection"}</CardTitle>
        <CardDescription>
          MySQL サーバーへの接続情報を入力します。パスワードは OS キーチェーン、 それ以外はローカル
          SQLite に保存されます。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            placeholder="e.g. Local dev"
            value={values.name}
            onChange={(e) => update("name", e.currentTarget.value)}
          />
        </div>

        <div className="grid grid-cols-[1fr_120px] gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="host">Host</Label>
            <Input
              id="host"
              value={values.host}
              onChange={(e) => update("host", e.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              value={values.port}
              onChange={(e) => update("port", Number(e.currentTarget.value) || 0)}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="user">User</Label>
            <Input
              id="user"
              value={values.user}
              onChange={(e) => update("user", e.currentTarget.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="password">
              Password
              {initial && (
                <span className="text-muted-foreground ml-1 text-xs">(再入力が必要です)</span>
              )}
            </Label>
            <Input
              id="password"
              type="password"
              value={values.password}
              onChange={(e) => update("password", e.currentTarget.value)}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="database">Database (optional)</Label>
          <Input
            id="database"
            value={values.database}
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
            checked={values.use_ssl}
            onCheckedChange={(value) => update("use_ssl", value)}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={handleTest} disabled={testing || saving} variant="secondary">
            {testing ? "Testing…" : "Test connection"}
          </Button>
          <Button onClick={handleSave} disabled={testing || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {status.kind === "ok" && (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">{status.message}</span>
          )}
          {status.kind === "error" && (
            <span className="text-destructive text-sm">{status.message}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
