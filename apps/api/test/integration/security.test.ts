import { afterAll, describe, expect, it } from 'vitest';
import { createTestContext } from './harness.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

/**
 * Tables that are deliberately not tenant-scoped by RLS (docs/02-architecture.md §5):
 * users and auth tokens are per user and only the auth module reads them; jobs are claimed by
 * workers across tenants and always filtered by organization in code.
 */
const NO_RLS = new Set([
  '_prisma_migrations',
  'users',
  'refresh_tokens',
  'password_reset_tokens',
  'jobs',
]);

describe('row-level security coverage', () => {
  it('enables and forces RLS on every tenant table, with at least one policy', async () => {
    const tables = await ctx.owner.$queryRaw<
      { name: string; enabled: boolean; forced: boolean; policies: number }[]
    >`
      SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
             (SELECT count(*)::int FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`;
    expect(tables.length).toBeGreaterThan(15);
    const unprotected = tables
      .filter((t) => !NO_RLS.has(t.name))
      .filter((t) => !t.enabled || !t.forced || t.policies === 0)
      .map((t) => t.name);
    expect(unprotected).toEqual([]);
    // Every table without RLS is a deliberate, documented exception.
    const open = tables.filter((t) => !t.enabled).map((t) => t.name);
    expect(open.every((name) => NO_RLS.has(name))).toBe(true);
  });

  it('runs the app as a role that cannot bypass RLS or change the schema', async () => {
    const [role] = await ctx.db.run(
      {},
      (tx) =>
        tx.$queryRaw<{ name: string; superuser: boolean; bypass: boolean; create: boolean }[]>`
        SELECT r.rolname AS name, r.rolsuper AS superuser, r.rolbypassrls AS bypass,
               has_schema_privilege(r.rolname, 'public', 'CREATE') AS create
        FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(role).toMatchObject({ superuser: false, bypass: false, create: false });
  });

  it('sees nothing in tenant tables without an organization context', async () => {
    const counts = await ctx.db.run(
      {},
      (tx) =>
        tx.$queryRaw<{ customers: number; orders: number; audit: number }[]>`
        SELECT (SELECT count(*)::int FROM customers) AS customers,
               (SELECT count(*)::int FROM orders) AS orders,
               (SELECT count(*)::int FROM audit_logs) AS audit`,
    );
    expect(counts[0]).toEqual({ customers: 0, orders: 0, audit: 0 });
  });
});
