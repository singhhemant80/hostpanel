import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Site } from "../api";
import { Badge, Button, Card, Empty } from "../components/ui";

// ---------------- Terminal ----------------
export default function TerminalTab({ site, allowed }: { site: Site; allowed: boolean }) {
  const { t } = useTranslation();
  const el = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");
  const [session, setSession] = useState(0);
  useEffect(() => {
    if (!allowed || !el.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: "ui-monospace, Menlo, monospace", theme: { background: "#0f172a" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current);
    fit.fit();
    setState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/v1/terminal?site=${site.id}&cols=${term.cols}&rows=${term.rows}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      setState("open");
      term.focus();
    };
    ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => {
      setState("closed");
      term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
    };
    const sub = term.onData((d) => ws.readyState === WebSocket.OPEN && ws.send(d));
    return () => {
      sub.dispose();
      ws.close();
      term.dispose();
    };
  }, [site.id, allowed, session]);

  if (!allowed) {
    return (
      <Card>
        <Empty>{t("terminal.notAllowed")}</Empty>
      </Card>
    );
  }
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {t("sites.tabs.terminal")} <Badge tone={state === "open" ? "green" : state === "connecting" ? "yellow" : "gray"}>{state}</Badge>
        </span>
      }
      actions={
        state === "closed" ? (
          <Button variant="secondary" onClick={() => setSession((s) => s + 1)}>
            {t("terminal.reconnect")}
          </Button>
        ) : undefined
      }
    >
      <div ref={el} className="h-[60vh] overflow-hidden rounded-lg bg-slate-900 p-2" />
      <p className="mt-2 text-xs text-slate-500">{t("terminal.hint")}</p>
    </Card>
  );
}
