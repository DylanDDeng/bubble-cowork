import { useEffect, useState } from "react";
import { SettingsGroup } from "./SettingsPrimitives";
import { environmentLabel, type RemoteEnvironment } from "../../../shared/remote/protocol";
interface Status {
  status: string;
  enabled: boolean;
  environment: RemoteEnvironment;
  relay: string;
  projects: { id: string; name: string }[];
  projectIds: string[];
  devices: { peerId: string; name: string }[];
}
export function RemoteCompanionSettings() {
  const [status, setStatus] = useState<Status>();
  const [relay, setRelay] = useState("");
  const [token, setToken] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [pair, setPair] = useState<{
    url: string;
    qr: string;
    expiresAt: number;
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      window.electron
        .remoteCompanion("status")
        .then((s: Status) => {
          if (alive) setStatus(s);
        })
        .catch((e: Error) => {
          if (alive) setError(e.message);
        });
    void load();
    const timer = setInterval(load, 2500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  const act = async (action: string, payload?: unknown) => {
    setBusy(true);
    setError("");
    try {
      const result = await window.electron.remoteCompanion(action, payload);
      if (action === "pair") setPair(result);
      else {
        setStatus(result);
        setPair(undefined);
        setToken("");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const input =
    "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-sm";
  return (
    <SettingsGroup title="iPhone 远程访问 · 技术预览">
      <div className="space-y-3 rounded-xl border border-[var(--border)] p-4 text-sm">
        <p>
          在 iPhone 查看会话、发任务、停止及处理工具审批。关闭 Mac
          窗口后仍可连接；退出或睡眠时不可用。
        </p>
        <p className="text-[var(--text-muted)]">
          数据来源：{status ? environmentLabel(status.environment) : "加载中"}。
          连接状态：{status?.status || "加载中"}。仅支持一台手机同时在线。
        </p>
        {error && (
          <p role="alert" className="text-red-500">
            {error}
          </p>
        )}
        {!status?.enabled && (
          <>
            <label className="block">
              中继地址
              <input
                aria-label="中继地址"
                className={input}
                placeholder="wss://relay.example.com"
                value={relay}
                onChange={(e) => setRelay(e.target.value)}
              />
            </label>
            <label className="block">
              中继注册凭据
              <input
                aria-label="中继注册凭据"
                type="password"
                className={input}
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <fieldset>
              <legend className="mb-2">允许手机访问的项目</legend>
              {status?.projects.map((p) => (
                <label key={p.id} className="mr-4 inline-flex gap-2 py-2">
                  <input
                    type="checkbox"
                    checked={selected.includes(p.id)}
                    onChange={(e) =>
                      setSelected((ids) =>
                        e.target.checked
                          ? [...ids, p.id]
                          : ids.filter((id) => id !== p.id),
                      )
                    }
                  />
                  {p.name}
                </label>
              ))}
              {!status?.projects.length && <p>先在桌面项目中创建一个会话。</p>}
            </fieldset>
            <button
              disabled={busy || !selected.length || !relay || !token}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 text-white disabled:opacity-40"
              onClick={() =>
                void act("configure", { relay, token, projectIds: selected })
              }
            >
              启用远程访问
            </button>
          </>
        )}
        {status?.enabled && (
          <div className="flex gap-4">
            <button
              disabled={
                busy || !["waiting", "connected"].includes(status.status)
              }
              onClick={() => void act("pair")}
            >
              生成配对码
            </button>
            <button disabled={busy} onClick={() => void act("disable")}>
              关闭远程访问
            </button>
          </div>
        )}
        {pair && (
          <div className="space-y-2">
            <img
              src={pair.qr}
              width={240}
              height={240}
              alt="两分钟有效的 iPhone 配对二维码"
            />
            <p>在 iPhone 输入或扫码配对后，请核对并确认电脑上的授权窗口。</p>
            <textarea
              aria-label="配对链接"
              readOnly
              className={input}
              value={pair.url}
            />
            <p className="text-xs">
              有效至 {new Date(pair.expiresAt).toLocaleTimeString()}，用后失效。
            </p>
          </div>
        )}
        {status?.devices.map((d) => (
          <div
            key={d.peerId}
            className="flex items-center justify-between gap-4"
          >
            <span>{d.name}</span>
            <button
              disabled={busy}
              onClick={() => void act("revoke", { peerId: d.peerId })}
            >
              撤销访问
            </button>
          </div>
        ))}
      </div>
    </SettingsGroup>
  );
}
