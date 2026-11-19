// Creates or updates the runtime database role used by the API and the analytics service.
// It is a non-owner role subject to row-level security (NOBYPASSRLS), with DML only on tables
// that migrations create. Idempotent: run before every deploy (Render preDeployCommand).
// Same effect as infra/postgres/init/01-app-role.sh, for managed Postgres without init scripts.
//
//   DIRECT_DATABASE_URL  owner connection (runs migrations)
//   APP_DB_USER          runtime role name, e.g. app_user
//   APP_DB_PASSWORD      runtime role password (a generated secret)
import pg from 'pg';

const { DIRECT_DATABASE_URL, APP_DB_USER, APP_DB_PASSWORD } = process.env;
if (!DIRECT_DATABASE_URL || !APP_DB_USER || !APP_DB_PASSWORD) {
  console.error('DIRECT_DATABASE_URL, APP_DB_USER and APP_DB_PASSWORD are required');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(APP_DB_USER)) {
  console.error('APP_DB_USER must be a plain lower-case identifier');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DIRECT_DATABASE_URL });
await client.connect();
try {
  const ident = (s) => client.escapeIdentifier(s);
  const literal = (s) => client.escapeLiteral(s);
  const { rows } = await client.query('SELECT current_user AS owner, current_database() AS db');
  const { owner, db } = rows[0];
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_DB_USER]);
  const attributes = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS';
  // Role DDL cannot take bind parameters: values are escaped above.
  await client.query(
    exists.rowCount
      ? `ALTER ROLE ${ident(APP_DB_USER)} ${attributes} PASSWORD ${literal(APP_DB_PASSWORD)}`
      : `CREATE ROLE ${ident(APP_DB_USER)} ${attributes} PASSWORD ${literal(APP_DB_PASSWORD)}`,
  );
  const grants = [
    `GRANT CONNECT ON DATABASE ${ident(db)} TO ${ident(APP_DB_USER)}`,
    `GRANT USAGE ON SCHEMA public TO ${ident(APP_DB_USER)}`,
    // Existing objects (a fresh database has none yet; re-runs after migrations do).
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident(APP_DB_USER)}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident(APP_DB_USER)}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ident(APP_DB_USER)}`,
    // Objects created later by migrations (run as the owner).
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident(APP_DB_USER)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident(APP_DB_USER)}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ident(owner)} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${ident(APP_DB_USER)}`,
  ];
  for (const sql of grants) await client.query(sql);
  console.log(`runtime role ${APP_DB_USER} ready (owner ${owner}, database ${db})`);
} finally {
  await client.end();
}
