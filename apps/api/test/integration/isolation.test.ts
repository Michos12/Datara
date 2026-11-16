/**
 * Cross-tenant isolation suite (NFR-SEC-01, ADR-0004). Every milestone that adds tenant data
 * adds its endpoints and tables here.
 *
 *  1. HTTP layer: a token for organization A never returns organization B's data.
 *  2. Database layer: with the application's own filters bypassed, row-level security alone
 *     keeps tenants apart, and no tenant context means no rows.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/ids.js';
import { authed, createTestContext, signup, type TestSession } from './harness.js';

const ctx = createTestContext();
let a: TestSession;
let b: TestSession;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  a = await signup(ctx.app, {
    organization: { name: 'Tenant A', timezone: 'UTC', currency: 'USD', industry: 'retail' },
  });
  b = await signup(ctx.app, {
    organization: { name: 'Tenant B', timezone: 'UTC', currency: 'EUR', industry: 'services' },
  });
  orgA = a.body.organization.id;
  orgB = b.body.organization.id;
  // Give B some audit history that A must never see.
  await authed(ctx.app, b.accessToken).patch('/organization', { name: 'Tenant B (secret)' });
});
afterAll(() => ctx.close());

describe('HTTP layer', () => {
  /** Each case: an endpoint and how to tell that only A's data came back. */
  const endpoints: { path: string; assert: (body: unknown) => void }[] = [
    {
      path: '/organization',
      assert: (body) => expect((body as { id: string }).id).toBe(orgA),
    },
    {
      path: '/auth/me',
      assert: (body) => {
        const session = body as {
          organization: { id: string };
          memberships: { organizationId: string }[];
        };
        expect(session.organization.id).toBe(orgA);
        expect(session.memberships.map((m) => m.organizationId)).toEqual([orgA]);
      },
    },
    {
      path: '/organization/audit-logs',
      assert: (body) => {
        const text = JSON.stringify(body);
        expect(text).not.toContain(orgB);
        expect(text).not.toContain('Tenant B');
      },
    },
  ];

  it.each(endpoints)("$path returns only the caller's organization", async ({ path, assert }) => {
    const res = await authed(ctx.app, a.accessToken).get(path);
    expect(res.status).toBe(200);
    assert(res.body);
  });

  it("a member of A cannot reach B's data even with a valid token for A", async () => {
    // There is no organization ID in any URL: the organization always comes from the token.
    const res = await authed(ctx.app, a.accessToken).patch('/organization', { name: 'Hijack' });
    expect(res.status).toBe(200);
    const bOrg = await authed(ctx.app, b.accessToken).get('/organization');
    expect(bOrg.body.name).toBe('Tenant B (secret)');
  });
});

describe('database layer (row-level security, app filters bypassed)', () => {
  it('shows only the active tenant even for unfiltered queries', async () => {
    await ctx.db.run({ organizationId: orgA }, async (tx) => {
      const orgs = await tx.organization.findMany();
      const memberships = await tx.membership.findMany();
      const audit = await tx.auditLog.findMany();
      expect(orgs.map((o) => o.id)).toEqual([orgA]);
      expect(new Set(memberships.map((m) => m.organizationId))).toEqual(new Set([orgA]));
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((e) => e.organizationId === orgA)).toBe(true);
    });
  });

  it('returns nothing when no tenant context is set (fail closed)', async () => {
    await ctx.db.run({}, async (tx) => {
      expect(await tx.organization.count()).toBe(0);
      expect(await tx.membership.count()).toBe(0);
      expect(await tx.auditLog.count()).toBe(0);
    });
  });

  it("cannot update or delete another tenant's rows", async () => {
    await ctx.db.run({ organizationId: orgA }, async (tx) => {
      const updated = await tx.organization.updateMany({
        where: { id: orgB },
        data: { name: 'x' },
      });
      const deleted = await tx.membership.deleteMany({ where: { organizationId: orgB } });
      expect(updated.count).toBe(0);
      expect(deleted.count).toBe(0);
    });
    const bOrg = await ctx.owner.organization.findUnique({ where: { id: orgB } });
    expect(bOrg?.name).toBe('Tenant B (secret)');
  });

  it('cannot insert rows into another tenant', async () => {
    await expect(
      ctx.db.run({ organizationId: orgA }, (tx) =>
        tx.auditLog.create({ data: { id: newId(), organizationId: orgB, action: 'forged' } }),
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('keeps the audit log append-only for the runtime role', async () => {
    await ctx.db.run({ organizationId: orgA }, async (tx) => {
      const changed = await tx.auditLog.updateMany({ data: { action: 'tampered' } });
      const removed = await tx.auditLog.deleteMany({});
      expect(changed.count).toBe(0);
      expect(removed.count).toBe(0);
    });
  });

  it('does not leak tenant context between transactions on pooled connections', async () => {
    await ctx.db.run({ organizationId: orgA }, (tx) => tx.organization.findMany());
    const leaked = await ctx.db.run(
      {},
      (tx) => tx.$queryRaw<{ org: string | null }[]>`SELECT app_current_org()::text AS org`,
    );
    expect(leaked[0]?.org).toBeNull();
  });

  it('a user sees their own memberships across tenants, but not other users’', async () => {
    const memberships = await ctx.db.run({ userId: a.body.user.id }, (tx) =>
      tx.membership.findMany(),
    );
    expect(memberships.map((m) => m.userId)).toEqual([a.body.user.id]);
  });
});
