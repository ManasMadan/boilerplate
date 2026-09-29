/**
 * Status line: branch, uncommitted changes and which core local services accept
 * connections. It runs after every assistant message, so it stays at about 100ms: one
 * git call and a TCP connect per service (localhost refuses instantly when nothing
 * listens). It never calls Docker, which can take seconds to answer.
 */
import { connect } from "node:net";

// The default host ports from docker-compose.yml. Overrides in .env are not read here.
const services = [
  { name: "pg", port: 55432 },
  { name: "valkey", port: 56379 },
  { name: "mail", port: 51025 },
];

const input = (await Bun.stdin.json().catch(() => ({}))) as {
  workspace?: { project_dir?: string };
};
const cwd = input.workspace?.project_dir ?? process.cwd();

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 150 });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

const git = Bun.spawnSync(["git", "status", "--porcelain=v1", "--branch"], { cwd });
const [head = "", ...changes] = git.stdout.toString().trim().split("\n");
const branch = head.replace(/^## /, "").split("...")[0] || "no git";
const dirty = changes.filter(Boolean).length;

const up = await Promise.all(services.map((service) => listening(service.port)));
const status = services
  .map((service, index) => `${service.name} ${up[index] ? "up" : "down"}`)
  .join(" ");

process.stdout.write(`${branch}${dirty ? ` +${dirty}` : ""} | ${status}`);
