-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" UUID,
    "details" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_family_id_idx" ON "refresh_tokens"("family_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row-level security (ADR-0004)
--
-- Context comes from transaction-local settings set by the application:
--   app.org_id  → app_current_org()   the active organization
--   app.user_id → app_current_user()  the signed-in user (lets a user see their own
--                                     memberships and organizations before choosing one)
-- Unset settings return NULL, and NULL never equals anything, so with no context every
-- policy matches zero rows (fail closed).
--
-- FORCE makes policies apply to the table owner too. The runtime role (app_user) is not the
-- owner and has NOBYPASSRLS; migrations run as the owner.
-- Tables without RLS by design: users and refresh_tokens (auth module only, looked up by
-- unique email / token hash), jobs (workers must see every tenant's pending jobs).
-- ─────────────────────────────────────────────────────────────────────────────

-- organizations: readable when active, or when the user is a member; writable only when active.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "organizations_select" ON "organizations" FOR SELECT
  USING (
    "id" = app_current_org()
    OR "id" IN (SELECT m."organization_id" FROM "memberships" m WHERE m."user_id" = app_current_user())
  );
CREATE POLICY "organizations_insert" ON "organizations" FOR INSERT
  WITH CHECK ("id" = app_current_org());
CREATE POLICY "organizations_update" ON "organizations" FOR UPDATE
  USING ("id" = app_current_org()) WITH CHECK ("id" = app_current_org());
CREATE POLICY "organizations_delete" ON "organizations" FOR DELETE
  USING ("id" = app_current_org());

-- memberships: a user sees their own memberships in any organization, and all memberships
-- of the active organization; writes are limited to the active organization.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memberships_select" ON "memberships" FOR SELECT
  USING ("organization_id" = app_current_org() OR "user_id" = app_current_user());
CREATE POLICY "memberships_insert" ON "memberships" FOR INSERT
  WITH CHECK ("organization_id" = app_current_org());
CREATE POLICY "memberships_update" ON "memberships" FOR UPDATE
  USING ("organization_id" = app_current_org()) WITH CHECK ("organization_id" = app_current_org());
CREATE POLICY "memberships_delete" ON "memberships" FOR DELETE
  USING ("organization_id" = app_current_org());

-- audit_logs: strictly the active organization, and append-only for the runtime role.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_select" ON "audit_logs" FOR SELECT
  USING ("organization_id" = app_current_org());
CREATE POLICY "audit_logs_insert" ON "audit_logs" FOR INSERT
  WITH CHECK ("organization_id" = app_current_org());
-- No UPDATE/DELETE policies: with RLS enabled, those commands match no rows.

