// Small DB helper for the demo runner. Uses the `pg` package from the pre-installed DEMO_DEPS directory.
//   node db_tool.mjs setup   -> creates the demo app role + a generated database (admin URL from env)
//   node db_tool.mjs state   -> prints a JSON snapshot of the demo rows (read only)
// Connection strings come from the environment only (DEMO_ADMIN_URL, DEMO_DB_NAME, DEMO_APP_ROLE,
// DEMO_APP_PASSWORD_FILE); nothing secret is printed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.join(process.env.DEMO_DEPS, 'noop.js'));
const pg = require('pg');

const DB_NAME_RE = /^ops_e2e_[a-z0-9]+_\d+$/; // same shape the app's tests/db-guard.ts accepts
const ROLE_RE = /^[a-z_][a-z0-9_]{0,40}$/;

function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function assertLoopback(url) {
  const u = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('db_tool: loopback only');
  if (u.port !== process.env.DEMO_PG_PORT) throw new Error('db_tool: unexpected port');
}

async function setup() {
  const admin = process.env.DEMO_ADMIN_URL;
  const dbName = process.env.DEMO_DB_NAME;
  const role = process.env.DEMO_APP_ROLE;
  assertLoopback(admin);
  if (!DB_NAME_RE.test(dbName)) throw new Error('db_tool: refusing non-generated database name');
  if (!ROLE_RE.test(role)) throw new Error('db_tool: bad role name');
  const pw = readFileSync(process.env.DEMO_APP_PASSWORD_FILE, 'utf8').trim();
  const c = new pg.Client({ connectionString: withDatabase(admin, 'postgres') });
  await c.connect();
  try {
    await c.query(`create role ${c.escapeIdentifier(role)} login password ${c.escapeLiteral(pw)} nosuperuser nocreatedb nocreaterole`);
    await c.query(`create database ${c.escapeIdentifier(dbName)}`);
    const v = await c.query('select version() as v, inet_server_addr()::text as addr, inet_server_port() as port');
    console.log(JSON.stringify({ created_role: role, created_database: dbName, server: v.rows[0] }));
  } finally {
    await c.end();
  }
}

async function state() {
  const url = withDatabase(process.env.DEMO_ADMIN_URL, process.env.DEMO_DB_NAME);
  assertLoopback(url);
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin read only');
    const q = async (sql) => (await c.query(sql)).rows;
    const out = {
      counts: (
        await q(`select (select count(*)::int from reviews) as reviews, (select count(*)::int from brands) as brands,
                 (select count(*)::int from tasks) as tasks, (select count(*)::int from mail_candidates) as mail_candidates`)
      )[0],
      candidates: await q(`select id::int, message_id, thread_id, subject, status, review_id::int, version::int
                           from mail_candidates order by id`),
      reviews: await q(`select r.id::int, r.product_name, b.name as brand_name, r.source_type,
                        to_char(r.write_due_on, 'YYYY-MM-DD') as write_due_on,
                        to_char(r.publish_planned_on, 'YYYY-MM-DD') as publish_planned_on,
                        to_char(r.embargo_until, 'YYYY-MM-DD') as embargo_until, s.name as stage_name
                        from reviews r left join brands b on b.id = r.brand_id left join workflow_stages s on s.id = r.stage_id order by r.id`),
      brands: await q('select id::int, name from brands order by id'),
      migrations: (await q('select count(*)::int as n from schema_migrations'))[0].n,
    };
    await c.query('rollback');
    console.log(JSON.stringify(out));
  } finally {
    await c.end();
  }
}

const cmd = process.argv[2];
try {
  if (cmd === 'setup') await setup();
  else if (cmd === 'state') await state();
  else throw new Error('usage: db_tool.mjs setup|state');
} catch (error) {
  console.error(`db_tool: ${error.message}`);
  process.exitCode = 1;
}
