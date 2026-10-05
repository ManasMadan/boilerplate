// Fails when an installed package's required peer dependency isn't installed. The repo
// installs peers only where they're declared (bunfig: peer = false), so a runtime
// dependency whose peer nobody declares would crash the service on first import. This
// runs on each image's production dependencies, before anything ships.
//
//   node check-peers.mjs <dir containing node_modules>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.argv[2] ?? ".";

function* packages(dir) {
  if (!existsSync(dir)) {
    return;
  }
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) {
      continue;
    }
    const path = join(dir, name);
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(path)) {
        yield join(path, scoped);
      }
    } else {
      yield path;
    }
  }
}

/** Node's lookup: node_modules/<name> in the package's directory and every parent. */
function resolvable(from, name) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) {
      return true;
    }
    if (dirname(dir) === dir) {
      return false;
    }
  }
}

const missing = [];
const seen = new Set();
const queue = [join(root, "node_modules")];
while (queue.length > 0) {
  for (const dir of packages(queue.pop())) {
    const manifest = join(dir, "package.json");
    if (seen.has(dir) || !existsSync(manifest)) {
      continue;
    }
    seen.add(dir);
    queue.push(join(dir, "node_modules"));
    const {
      name,
      peerDependencies = {},
      peerDependenciesMeta = {},
    } = JSON.parse(readFileSync(manifest, "utf8"));
    for (const peer of Object.keys(peerDependencies)) {
      if (peerDependenciesMeta[peer]?.optional) {
        continue;
      }
      if (!resolvable(dir, peer)) {
        missing.push(`${name} needs ${peer}`);
      }
    }
  }
}

if (missing.length > 0) {
  console.error(`Missing peer dependencies (declare them where the package is used):`);
  for (const line of [...new Set(missing)].sort()) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(`Peer dependencies OK (${seen.size} packages).`);
