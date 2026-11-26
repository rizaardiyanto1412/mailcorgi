import type { Migration } from '../../core/db.ts'

/**
 * Email sequences (drips). A sequence owns ordered steps; each step owns one hidden `campaigns` row
 * (`kind = 'sequence'`) that holds its content, so rendering, tracking, deliveries and stats are the
 * campaign ones. An enrollment is one contact's run through one sequence, at most once ever.
 *
 * Indexes (every entry is a row written): `sequences_newsletter` serves the list and the tag hook,
 * which looks up a newsletter's active sequences on every tag write; `sequence_enrollments_due` is
 * the scheduler's scan and holds only enrollments that still wait for a step. The UNIQUE keys serve
 * the step list and the "is this contact enrolled" check.
 */
export const migrations: readonly Migration[] = [{
  id: '2026-11-26-sequences-tables',
  sql: `
    CREATE TABLE sequences (
      id TEXT PRIMARY KEY,
      newsletter_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'active', 'paused', 'archived')),
      entry TEXT NOT NULL,
      exit TEXT NOT NULL DEFAULT '{}',
      delay_anchor TEXT NOT NULL DEFAULT 'enrolled_at' CHECK(delay_anchor IN ('enrolled_at')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX sequences_newsletter ON sequences(newsletter_id, status);
    CREATE TABLE sequence_steps (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      delay_days INTEGER NOT NULL CHECK(delay_days >= 0),
      campaign_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (sequence_id, position)
    );
    CREATE TABLE sequence_enrollments (
      id TEXT PRIMARY KEY,
      sequence_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'exited')),
      source TEXT NOT NULL DEFAULT '',
      enrolled_at INTEGER NOT NULL,
      last_step_id TEXT,
      next_step_id TEXT,
      next_run_at INTEGER,
      exit_reason TEXT,
      paused_at INTEGER,
      finished_at INTEGER,
      UNIQUE (sequence_id, contact_id)
    );
    CREATE INDEX sequence_enrollments_due ON sequence_enrollments(next_run_at) WHERE status = 'active' AND next_run_at IS NOT NULL;
  `,
}]
