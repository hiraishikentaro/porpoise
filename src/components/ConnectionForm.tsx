import { type ReactNode, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type ConnectionConfig,
  type SavedConnection,
  type SshAuthInput,
  type SslMode,
  saveConnection,
  testConnection,
} from "@/lib/tauri";

type SshAuthKind = "password" | "key";

type FormValues = {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: SslMode;
  sslCaCertPath: string;
  sslClientCertPath: string;
  sslClientKeyPath: string;
  enableCleartextPlugin: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuthKind: SshAuthKind;
  sshPassword: string;
  sshKeyPath: string;
  sshPassphrase: string;
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
  sslMode: "disabled",
  sslCaCertPath: "",
  sslClientCertPath: "",
  sslClientKeyPath: "",
  enableCleartextPlugin: false,
  sshEnabled: false,
  sshHost: "",
  sshPort: 22,
  sshUser: "",
  sshAuthKind: "password",
  sshPassword: "",
  sshKeyPath: "",
  sshPassphrase: "",
};

type Props = {
  initial: SavedConnection | null;
  onSaved: (conn: SavedConnection) => void;
};

function optionalString(value: string): string | null {
  return value.trim() ? value.trim() : null;
}

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
        sslMode: initial.ssl.mode,
        sslCaCertPath: initial.ssl.ca_cert_path ?? "",
        sslClientCertPath: initial.ssl.client_cert_path ?? "",
        sslClientKeyPath: initial.ssl.client_key_path ?? "",
        enableCleartextPlugin: initial.enable_cleartext_plugin,
        sshEnabled: initial.ssh !== null,
        sshHost: initial.ssh?.host ?? "",
        sshPort: initial.ssh?.port ?? 22,
        sshUser: initial.ssh?.user ?? "",
        sshAuthKind: initial.ssh?.auth_kind ?? "password",
        sshPassword: "",
        sshKeyPath: initial.ssh?.key_path ?? "",
        sshPassphrase: "",
      });
      setStatus({ kind: "idle" });
    }
  }, [initial]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function buildSshAuth(): SshAuthInput {
    if (values.sshAuthKind === "password") {
      return { kind: "password", password: values.sshPassword };
    }
    return {
      kind: "key",
      key_path: values.sshKeyPath.trim(),
      passphrase: optionalString(values.sshPassphrase),
    };
  }

  function toConfig(): ConnectionConfig {
    return {
      host: values.host,
      port: values.port,
      user: values.user,
      password: values.password,
      database: optionalString(values.database),
      ssl: {
        mode: values.sslMode,
        ca_cert_path: optionalString(values.sslCaCertPath),
        client_cert_path: optionalString(values.sslClientCertPath),
        client_key_path: optionalString(values.sslClientKeyPath),
      },
      ssh: values.sshEnabled
        ? {
            host: values.sshHost.trim(),
            port: values.sshPort,
            user: values.sshUser.trim(),
            auth: buildSshAuth(),
          }
        : null,
      enable_cleartext_plugin: values.enableCleartextPlugin,
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
      setStatus({ kind: "error", message: "Name is required." });
      return;
    }
    setStatus({ kind: "pending", action: "save" });
    try {
      const saved = await saveConnection({ ...toConfig(), name: values.name.trim() });
      setStatus({ kind: "ok", message: `Saved "${saved.name}"` });
      onSaved(saved);
    } catch (err) {
      setStatus({ kind: "error", message: String(err) });
    }
  }

  const testing = status.kind === "pending" && status.action === "test";
  const saving = status.kind === "pending" && status.action === "save";
  const showCaCert =
    values.sslMode === "verify_ca" ||
    values.sslMode === "verify_identity" ||
    values.sslCaCertPath.length > 0;

  return (
    <article className="w-full max-w-2xl">
      <header className="mb-6 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">{initial ? initial.name : "MySQL Connection"}</h2>
        <span className="text-xs text-muted-foreground">
          {initial ? `id ${initial.id.slice(0, 8)}` : "New"}
        </span>
      </header>

      <div className="flex flex-col gap-4">
        <Row label="Name">
          <input
            className="tp-input"
            placeholder="e.g. Local MySQL"
            value={values.name}
            onChange={(e) => update("name", e.currentTarget.value)}
          />
        </Row>

        <Row label="Host / Port">
          <div className="grid grid-cols-[1fr_100px] gap-2">
            <input
              className="tp-input"
              placeholder="127.0.0.1"
              value={values.host}
              onChange={(e) => update("host", e.currentTarget.value)}
            />
            <input
              className="tp-input"
              type="number"
              placeholder="3306"
              value={values.port}
              onChange={(e) => update("port", Number(e.currentTarget.value) || 0)}
            />
          </div>
        </Row>

        <Row label="User">
          <input
            className="tp-input"
            placeholder="root"
            value={values.user}
            onChange={(e) => update("user", e.currentTarget.value)}
          />
        </Row>

        <Row label="Password" hint={initial ? "re-enter" : undefined}>
          <input
            className="tp-input"
            type="password"
            placeholder="password"
            value={values.password}
            onChange={(e) => update("password", e.currentTarget.value)}
          />
        </Row>

        <Row label="Database">
          <input
            className="tp-input"
            placeholder="database name"
            value={values.database}
            onChange={(e) => update("database", e.currentTarget.value)}
          />
        </Row>

        <Row label="SSL mode">
          <Select value={values.sslMode} onValueChange={(v) => update("sslMode", v as SslMode)}>
            <SelectTrigger className="tp-input !h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="disabled">DISABLED</SelectItem>
              <SelectItem value="preferred">PREFERRED</SelectItem>
              <SelectItem value="required">REQUIRED</SelectItem>
              <SelectItem value="verify_ca">VERIFY CA</SelectItem>
              <SelectItem value="verify_identity">VERIFY IDENTITY</SelectItem>
            </SelectContent>
          </Select>
        </Row>

        <Row label="SSL keys">
          <div className="grid grid-cols-3 gap-2">
            <input
              className="tp-input"
              placeholder="Key…"
              value={values.sslClientKeyPath}
              onChange={(e) => update("sslClientKeyPath", e.currentTarget.value)}
            />
            <input
              className="tp-input"
              placeholder="Cert…"
              value={values.sslClientCertPath}
              onChange={(e) => update("sslClientCertPath", e.currentTarget.value)}
            />
            <input
              className="tp-input"
              placeholder="CA Cert…"
              value={values.sslCaCertPath}
              onChange={(e) => update("sslCaCertPath", e.currentTarget.value)}
            />
          </div>
        </Row>

        <Row label="Auth plugin">
          <label className="flex items-center gap-2 py-1 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4 accent-accent"
              checked={values.enableCleartextPlugin}
              onChange={(e) => update("enableCleartextPlugin", e.currentTarget.checked)}
            />
            <span>Enable Cleartext plugin</span>
            <span className="text-xs text-muted-foreground">(insecure — LDAP/PAM 用)</span>
          </label>
        </Row>

        {!showCaCert && values.sslMode === "disabled" && null}
      </div>

      {/* Over SSH block */}
      <div className="mt-6 rounded-md border border-border bg-card/40">
        <button
          type="button"
          onClick={() => update("sshEnabled", !values.sshEnabled)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
        >
          <span className="flex items-center gap-3">
            <span className="text-sm font-medium">Over SSH</span>
            {values.sshEnabled && (
              <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 text-[0.65rem] font-semibold tracking-wide uppercase text-accent">
                enabled
              </span>
            )}
          </span>
          <span className="text-xs text-muted-foreground">{values.sshEnabled ? "−" : "+"}</span>
        </button>
        {values.sshEnabled && (
          <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
            <Row label="SSH host">
              <div className="grid grid-cols-[1fr_100px] gap-2">
                <input
                  className="tp-input"
                  placeholder="bastion.example.com"
                  value={values.sshHost}
                  onChange={(e) => update("sshHost", e.currentTarget.value)}
                />
                <input
                  className="tp-input"
                  type="number"
                  placeholder="22"
                  value={values.sshPort}
                  onChange={(e) => update("sshPort", Number(e.currentTarget.value) || 0)}
                />
              </div>
            </Row>
            <Row label="SSH user">
              <input
                className="tp-input"
                placeholder="ec2-user"
                value={values.sshUser}
                onChange={(e) => update("sshUser", e.currentTarget.value)}
              />
            </Row>
            <Row label="Auth">
              <div className="inline-flex overflow-hidden rounded-md border border-border">
                <AuthTab
                  active={values.sshAuthKind === "password"}
                  onClick={() => update("sshAuthKind", "password")}
                >
                  Password
                </AuthTab>
                <AuthTab
                  active={values.sshAuthKind === "key"}
                  onClick={() => update("sshAuthKind", "key")}
                >
                  Key
                </AuthTab>
              </div>
            </Row>
            {values.sshAuthKind === "password" ? (
              <Row
                label="SSH password"
                hint={initial?.ssh?.auth_kind === "password" ? "re-enter" : undefined}
              >
                <input
                  className="tp-input"
                  type="password"
                  placeholder="password"
                  value={values.sshPassword}
                  onChange={(e) => update("sshPassword", e.currentTarget.value)}
                />
              </Row>
            ) : (
              <>
                <Row label="Key file">
                  <input
                    className="tp-input"
                    placeholder="/Users/you/.ssh/id_ed25519"
                    value={values.sshKeyPath}
                    onChange={(e) => update("sshKeyPath", e.currentTarget.value)}
                  />
                </Row>
                <Row
                  label="Passphrase"
                  hint={initial?.ssh?.auth_kind === "key" ? "re-enter" : undefined}
                >
                  <input
                    className="tp-input"
                    type="password"
                    placeholder="optional"
                    value={values.sshPassphrase}
                    onChange={(e) => update("sshPassphrase", e.currentTarget.value)}
                  />
                </Row>
              </>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <footer className="mt-6 flex flex-col gap-3">
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={testing || saving}
            className="tp-btn"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || saving}
            className="tp-btn"
          >
            {testing ? "Testing…" : "Test"}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || saving}
            className="tp-btn tp-btn-primary"
          >
            Connect
          </button>
        </div>
        {status.kind === "ok" && (
          <p className="flex items-center gap-2 text-sm" style={{ color: "oklch(0.72 0.15 145)" }}>
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
            {status.message}
          </p>
        )}
        {status.kind === "error" && (
          <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {status.message}
          </p>
        )}
      </footer>
    </article>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-start gap-4">
      <div className="tp-label">
        <span>
          {label}
          {hint && <span className="ml-1 text-[0.7rem] text-muted-foreground/70">({hint})</span>}
        </span>
      </div>
      <div>{children}</div>
    </div>
  );
}

function AuthTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? "bg-foreground text-background"
          : "bg-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}
