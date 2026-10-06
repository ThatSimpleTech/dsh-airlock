// Loaded into dsh with NODE_OPTIONS=--import for the proof run only. Records
// every outbound socket connect and DNS lookup the process makes to the JSONL
// file named by NETLOG_FILE, so the run can show exactly where dsh connected.
import net from "node:net";
import dns from "node:dns";
import fs from "node:fs";

const out = process.env.NETLOG_FILE;
const record = (kind, target) => {
  if (!out) return;
  try {
    fs.appendFileSync(out, JSON.stringify({ pid: process.pid, kind, target: String(target) }) + "\n");
  } catch {}
};

function describe(args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") return first.path ?? `${first.host ?? "localhost"}:${first.port}`;
  if (typeof first === "string" && Number.isNaN(Number(first))) return first; // unix socket path
  return `${typeof args[1] === "string" ? args[1] : "localhost"}:${first}`;
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  record("connect", describe(args));
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  record("dns", host);
  return lookup.call(this, host, ...rest);
};
const plookup = dns.promises.lookup;
dns.promises.lookup = function (host, ...rest) {
  record("dns", host);
  return plookup.call(this, host, ...rest);
};
record("hook-loaded", process.argv.slice(1, 3).join(" "));
