/**
 * Restore drill: `bun run db:restore-drill`. Proves a backup of the database can actually
 * be restored, not just taken. It dumps the database the way logical backups are taken
 * (pg_dump, custom format), restores the dump into a scratch database and requires it to
 * match the source exactly: every table's rows (count and a content hash), row-level
 * security (enabled, forced, every policy), each role's grants, default privileges,
 * functions, triggers, extensions and sequence positions. Then the scratch database and
 * the dump are removed, whatever the outcome.
 *
 *   bun run db:restore-drill                 the local database (compose "postgres")
 *   PG_CONTAINER=<name> bun run db:restore-drill      Postgres in another container (CI)
 *   bun run db:restore-drill <database>      another database than "app"
 *
 * Everything runs inside the Postgres container as its superuser, so no client tools are
 * needed, their version always matches the server, and row-level security doesn't hide
 * rows from the comparison. Roles and database-level grants (owner, CONNECT) are
 * cluster-wide and never part of a dump: a restore into a new cluster creates them first
 * (infra/postgres/init locally, the data chart's managed roles in Kubernetes).
 */
import { spawnSync } from "node:child_process";
import { fail, ok, ROOT } from "./lib";

const SOURCE = process.argv[2] ?? "app";
const SCRATCH = `${SOURCE}_restore_drill`;
const DUMP = `/tmp/${SCRATCH}.dump`;
const exec = process.env.PG_CONTAINER
  ? ["exec", "-i", process.env.PG_CONTAINER]
  : ["compose", "exec", "-T", "postgres"];

function pg(command: string[]) {
  const result = spawnSync("docker", [...exec, ...command], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// One line per fact about the database; a faithful restore yields exactly the same lines.
// ponytail: row hashes are order-independent sums of 64-bit row hashes, streamed, so
// memory stays flat on big tables; the ceiling is one full read of every table.
const FINGERPRINT = `
select format('table %s rows=%s hash=%s rls=%s forced=%s', c.oid::regclass,
    (xpath('/row/n/text()', t))[1], (xpath('/row/h/text()', t))[1],
    c.relrowsecurity, c.relforcerowsecurity)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral query_to_xml(format(
    'select count(*) as n, coalesce(sum(hashtextextended(r::text, 0)::numeric), 0) as h from %s r',
    c.oid::regclass), false, true, '') as t
  where c.relkind in ('r', 'p') and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg_toast%'
union all
select format('policy %I.%I %s %s %s roles=%s using=%s check=%s', schemaname, tablename,
    policyname, permissive, cmd, roles, qual, with_check)
  from pg_policies
union all
select format('grant %s %s on %I.%I', grantee, privilege_type, table_schema, table_name)
  from information_schema.role_table_grants
  where table_schema not in ('pg_catalog', 'information_schema')
union all
select format('schema %I owner=%s acl=%s', nspname, nspowner::regrole, nspacl)
  from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema'
union all
select format('default-acl %s in %s: %s', defaclrole::regrole, defaclnamespace::regnamespace, defaclacl)
  from pg_default_acl
union all
select format('function %s owner=%s definer=%s acl=%s', p.oid::regprocedure,
    p.proowner::regrole, p.prosecdef, p.proacl)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema')
    and not exists (select from pg_depend d where d.objid = p.oid and d.deptype = 'e')
union all
select format('trigger %s on %s', tgname, tgrelid::regclass) from pg_trigger where not tgisinternal
union all
select format('extension %s %s', extname, extversion) from pg_extension
union all
select format('sequence %I.%I last=%s', schemaname, sequencename, last_value) from pg_sequences
order by 1;`;

const fingerprint = (database: string) =>
  pg(["psql", "-U", "postgres", "-d", database, "-XAt", "-v", "ON_ERROR_STOP=1", "-c", FINGERPRINT])
    .split("\n")
    .filter(Boolean);

function cleanUp() {
  pg(["dropdb", "-U", "postgres", "--if-exists", "--force", SCRATCH]);
  pg(["rm", "-f", DUMP]);
}

let passed = false;
try {
  cleanUp();
  const before = fingerprint(SOURCE);
  pg(["pg_dump", "-U", "postgres", "-d", SOURCE, "--format=custom", "-f", DUMP]);
  ok(`backed up ${SOURCE}`);
  pg(["createdb", "-U", "postgres", "-T", "template0", SCRATCH]);
  pg(["pg_restore", "-U", "postgres", "-d", SCRATCH, "--exit-on-error", DUMP]);
  ok(`restored it into ${SCRATCH}`);
  const after = fingerprint(SCRATCH);

  const restored = new Set(after);
  const kept = new Set(before);
  const lost = before.filter((line) => !restored.has(line));
  const extra = after.filter((line) => !kept.has(line));
  if (lost.length === 0 && extra.length === 0) {
    const tables = before.filter((line) => line.startsWith("table ")).length;
    ok(`identical: ${tables} tables with their rows, security, grants and functions`);
    passed = true;
  } else {
    fail("the restore differs from the source");
    for (const line of lost) console.log(`    - ${line}`);
    for (const line of extra) console.log(`    + ${line}`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
} finally {
  try {
    cleanUp();
  } catch (error) {
    fail(`couldn't remove ${SCRATCH}: ${error instanceof Error ? error.message : error}`);
    passed = false;
  }
}
process.exit(passed ? 0 : 1);
