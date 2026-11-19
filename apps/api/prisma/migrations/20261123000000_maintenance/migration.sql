-- Hand-written: at most one pending maintenance cleanup (scheduled by every worker at start-up
-- and by each run for the next day; duplicates are suppressed by ON CONFLICT DO NOTHING).
CREATE UNIQUE INDEX "jobs_one_pending_maintenance" ON "jobs" ("type")
  WHERE "status" = 'PENDING' AND "type" = 'maintenance.cleanup';

-- Retention queries (prune by age).
CREATE INDEX "jobs_finished_at_idx" ON "jobs" ("finished_at") WHERE "finished_at" IS NOT NULL;
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" ("created_at");

-- Audit log retention (OPEN-11: 12 months). The log stays append-only for the runtime role
-- within its retention window: only entries older than 12 months can ever be deleted.
CREATE POLICY "audit_logs_retention_delete" ON "audit_logs" FOR DELETE
  USING ("organization_id" = app_current_org() AND "created_at" < now() - interval '12 months');
