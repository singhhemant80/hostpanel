import { test } from "node:test";
import assert from "node:assert/strict";
process.env.APP_ENCRYPTION_KEY ??= "1".repeat(64);
const { parsePayload } = await import("../src/validate.js");
const { buildCaddyfile } = await import("../src/caddy.js");
const { systemdQuote } = await import("../src/runtime.js");

const site = {
  id: "s1",
  name: "shop",
  linuxUser: "hp_acme",
  runtime: "node",
  runtimeVersion: "22",
  rootDir: "",
  publicDir: "",
  buildCmd: "npm ci",
  startCmd: "npm start",
  port: 20000,
  instances: 1,
  healthPath: "/",
  background: false,
  env: [],
};

test("rejects hostnames that could inject Caddyfile directives", () => {
  for (const hostname of ["evil.com {\n respond 1", "a b.com", "../x.com", "x.com\n"]) {
    assert.throws(() =>
      parsePayload("routes.sync", { routes: [{ hostname, kind: "static", siteName: "shop", linuxUser: "hp_acme", root: "/home/hp_acme/x" }], panelHostname: null, acmeEmail: null }),
    );
  }
});

test("rejects path traversal and bad users", () => {
  assert.throws(() => parsePayload("site.provision", { site: { ...site, rootDir: "../../etc" } }));
  assert.throws(() => parsePayload("site.provision", { site: { ...site, linuxUser: "root" } }));
  assert.throws(() => parsePayload("site.provision", { site: { ...site, runtimeVersion: "99" } }));
  assert.throws(() => parsePayload("db.create", { engine: "mariadb", name: "x`; DROP", user: "u_1", passwordEnc: "a" }));
  assert.ok(parsePayload("site.provision", { site }));
});

test("rejects unknown job types", () => {
  assert.throws(() => parsePayload("shell.exec", { cmd: "rm -rf /" }), /Unknown job type/);
});

test("Caddyfile: path rules come before the site's default handler", () => {
  const out = buildCaddyfile(
    [
      { hostname: "acme.in", kind: "static", siteName: "web", linuxUser: "hp_acme", root: "/home/hp_acme/sites/web/current/public", paths: [{ path: "/api/*", port: 20000, instances: 2 }] },
      { hostname: "old.acme.in", kind: "redirect", siteName: "web", linuxUser: "hp_acme", redirectTo: "https://acme.in/", redirectCode: 301 },
    ],
    "panel.acme.in",
    "ops@acme.in",
  );
  assert.match(out, /handle \/api\/\* \{\n\t\treverse_proxy 127\.0\.0\.1:20000 127\.0\.0\.1:20001/);
  assert.ok(out.indexOf("handle /api/*") < out.indexOf("handle {"));
  assert.match(out, /redir https:\/\/acme\.in\{uri\} 301/);
  assert.match(out, /panel\.acme\.in \{\n\tencode zstd gzip\n\treverse_proxy 127\.0\.0\.1:4100/);
});

test("systemd ExecStart quoting leaves $VARS and % for bash", () => {
  assert.equal(systemdQuote('API_PORT=$PORT node "a b" 100%'), '"API_PORT=$$PORT node \\"a b\\" 100%%"');
});

const { cronToOnCalendar } = await import("@hostpanel/shared");

test("cron → systemd OnCalendar", () => {
  assert.equal(cronToOnCalendar("*/15 * * * *"), "*-*-* *:00,15,30,45:00");
  assert.equal(cronToOnCalendar("0 9 * * 1-5"), "Mon,Tue,Wed,Thu,Fri *-*-* 09:00:00");
  assert.equal(cronToOnCalendar("@daily"), "*-*-* 00:00:00");
  assert.equal(cronToOnCalendar("30 4 1 * *"), "*-*-01 04:30:00");
  assert.equal(cronToOnCalendar("0 0 * * 7"), "Sun *-*-* 00:00:00");
  assert.throws(() => cronToOnCalendar("* * 1 * 1"), /either/);
  assert.throws(() => cronToOnCalendar("60 * * * *"), /minute/);
  assert.throws(() => cronToOnCalendar("* * *"), /5 fields/);
});

test("Caddyfile: custom certificate and DNS-issued wildcard", () => {
  const out = buildCaddyfile(
    [
      { hostname: "shop.in", kind: "static", siteName: "web", linuxUser: "hp_acme", root: "/home/hp_acme/sites/web/current", tls: { certEnc: "a.b.c", keyEnc: "a.b.c" } },
      { hostname: "*.apps.shop.in", kind: "proxy", siteName: "web", linuxUser: "hp_acme", port: 20010, instances: 1, tls: "dns" },
    ],
    null,
    null,
    "cf_token_abcdefghijklmnopqrstuvwxyz",
  );
  assert.match(out, /shop\.in \{\n\ttls \/etc\/caddy\/certs\/shop\.in\.crt \/etc\/caddy\/certs\/shop\.in\.key/);
  assert.match(out, /\*\.apps\.shop\.in \{\n\ttls \{\n\t\tdns cloudflare cf_token_abcdefghijklmnopqrstuvwxyz\n\t\}/);
  assert.throws(() => buildCaddyfile([{ hostname: "*.x.in", kind: "static", siteName: "web", linuxUser: "hp_acme", root: "/x", tls: "dns" }], null, null, null), /DNS provider token/);
  assert.throws(() => buildCaddyfile([], null, null, "bad token with spaces {}"), /unexpected characters/);
});

test("phase 2 payload validation", () => {
  assert.throws(() => parsePayload("fs.read", { linuxUser: "hp_acme", path: "../../etc/shadow" }));
  assert.throws(() => parsePayload("fs.read", { linuxUser: "hp_acme", path: "/etc/shadow" }));
  assert.throws(() => parsePayload("fs.delete", { linuxUser: "hp_acme", paths: [""] }), /home folder/);
  assert.throws(() => parsePayload("fs.chmod", { linuxUser: "hp_acme", path: "a", mode: "4777; rm" }));
  assert.throws(() => parsePayload("logs.read", { linuxUser: "hp_acme", siteName: "web", log: "../../shadow", bytes: 4096 }));
  assert.throws(() => parsePayload("cron.sync", { site, jobs: [{ id: "a1", onCalendar: "*-*-* 00:00:00\nExecStart=/bin/evil", command: "x", enabled: true }] }));
  assert.throws(() => parsePayload("access.sync", { linuxUser: "hp_acme", sftp: true, shell: false, passwordEnc: null, sshKeys: ["ssh-ed25519 AAAA\ncommand=evil"] }));
  assert.throws(() => parsePayload("backup.delete", { linuxUser: "hp_acme", fileName: "../../../etc/passwd", remote: null }));
  assert.ok(parsePayload("fs.list", { linuxUser: "hp_acme", path: "sites/web" }));
});

const { signTerminalToken, verifyTerminalToken } = await import("../src/terminal.js");

test("terminal tokens: signed, short-lived, confined to the user's home", () => {
  const ok = { u: "hp_acme", cwd: "/home/hp_acme/sites/web", cols: 80, rows: 24, exp: Math.floor(Date.now() / 1000) + 30 };
  assert.ok(verifyTerminalToken(signTerminalToken(ok)));
  assert.equal(verifyTerminalToken(signTerminalToken({ ...ok, exp: 1 })), null);
  assert.equal(verifyTerminalToken(signTerminalToken({ ...ok, cwd: "/home/hp_other/sites" })), null);
  assert.equal(verifyTerminalToken(signTerminalToken({ ...ok, cwd: "/home/hp_acme/x'; rm -rf /" })), null);
  const [body] = signTerminalToken(ok).split(".");
  assert.equal(verifyTerminalToken(`${body}.forged`), null);
});

test("phase 3 payload validation: mail, apps, servers", () => {
  const hash = "$2b$10$" + "a".repeat(53);
  const good = { mailHost: "panel.acme.in", domains: [{ name: "acme.in", catchAll: null }], mailboxes: [{ address: "me@acme.in", passwordHash: hash, quotaMb: 1024, enabled: true }], aliases: [{ source: "info@acme.in", destinations: ["me@acme.in"] }] };
  assert.ok(parsePayload("mail.sync", good));
  // a newline or colon in a mailbox line would add a user to the Dovecot passwd file
  assert.throws(() => parsePayload("mail.sync", { ...good, mailboxes: [{ ...good.mailboxes[0], address: "me@acme.in\nroot" }] }));
  assert.throws(() => parsePayload("mail.sync", { ...good, mailboxes: [{ ...good.mailboxes[0], passwordHash: "x:0:0" }] }));
  assert.throws(() => parsePayload("mail.sync", { ...good, aliases: [{ source: "a@acme.in", destinations: ["b@acme.in c@evil.in"] }] }));
  assert.throws(() => parsePayload("mail.purge", { address: "../../etc@acme.in" }));
  assert.throws(() => parsePayload("app.install", { site, template: "joomla", domain: "acme.in", deploymentId: "d1", db: null, admin: null }));
  assert.ok(parsePayload("app.install", { site, template: "nextjs", domain: "acme.in", deploymentId: "d1", db: null, admin: null }));
  const key = "A".repeat(43) + "=";
  assert.ok(parsePayload("server.addPeer", { publicKey: key, address: "10.88.0.2" }));
  assert.throws(() => parsePayload("server.addPeer", { publicKey: key + "\nAllowedIPs=0.0.0.0/0", address: "10.88.0.2" }));
  assert.throws(() => parsePayload("server.addPeer", { publicKey: key, address: "0.0.0.0/0" }));
});

test("Caddyfile: webmail is served under the panel hostname only when installed", () => {
  const without = buildCaddyfile([], "panel.acme.in", null);
  assert.ok(!without.includes("/webmail"));
  const withWm = buildCaddyfile([], "panel.acme.in", null, null, true);
  assert.match(withWm, /handle \/webmail\/\*/);
  assert.match(withWm, /hostpanel-webmail\.sock/);
  assert.ok(withWm.indexOf("/webmail/*") < withWm.indexOf("reverse_proxy 127.0.0.1:4100"));
});
