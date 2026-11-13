import { readFile } from "node:fs/promises";
import type { JobPayloads } from "@hostpanel/shared";
import { sys } from "../env.js";
import { run } from "../exec.js";
import { exists, writeFileAtomic } from "../fsx.js";

/**
 * Multi-server: extra servers join the main server's private WireGuard network (10.88.0.0/24,
 * interface wg-hp). Their agents reach the main server's Redis only through that tunnel.
 * These jobs run on the MAIN server's agent.
 */
const CONF = "/etc/wireguard/wg-hp.conf";

async function peersWithout(publicKey: string): Promise<string> {
  const conf = (await exists(CONF)) ? await readFile(sys(CONF), "utf8") : "";
  // drop any existing [Peer] block for this key (re-joins replace the old entry)
  return conf
    .split(/\n(?=\[Peer\])/)
    .filter((block) => !(block.startsWith("[Peer]") && block.includes(`PublicKey = ${publicKey}`)))
    .join("\n")
    .trimEnd();
}

export async function serverAddPeer(p: JobPayloads["server.addPeer"]): Promise<void> {
  if (!(await exists(CONF))) throw new Error("WireGuard is not set up on the main server (re-run install.sh to enable multi-server)");
  const conf = await peersWithout(p.publicKey);
  await writeFileAtomic(CONF, `${conf}\n\n[Peer]\n# HostPanel server ${p.address}\nPublicKey = ${p.publicKey}\nAllowedIPs = ${p.address}/32\n`, 0o600);
  await run("wg", ["set", "wg-hp", "peer", p.publicKey, "allowed-ips", `${p.address}/32`]);
}

export async function serverRemovePeer(p: JobPayloads["server.removePeer"]): Promise<void> {
  if (await exists(CONF)) await writeFileAtomic(CONF, `${await peersWithout(p.publicKey)}\n`, 0o600);
  await run("wg", ["set", "wg-hp", "peer", p.publicKey, "remove"], { allowFail: true });
}
