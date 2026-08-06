-- CI runs, releases, webhooks, notifications, and activity feeds.

-- One row per Workflow instance started by a cf.artifacts.repo.pushed event.
-- The Workflow itself is the source of truth for execution; this table exists so
-- the UI can list and filter runs without querying the Workflows API.
CREATE TABLE ci_runs (
  id                   TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  number               INTEGER NOT NULL,
  -- @cloudflare/ci derives this deterministically from the source commit, so a
  -- redelivered push event maps onto the same run instead of starting a new one.
  workflow_instance_id TEXT NOT NULL,

  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'success', 'failure', 'cancelled')),
  trigger              TEXT NOT NULL CHECK (trigger IN ('push', 'tag', 'manual')),
  ref                  TEXT NOT NULL,
  branch               TEXT,
  tag                  TEXT,
  sha                  TEXT NOT NULL,
  before_sha           TEXT NOT NULL DEFAULT '',
  commit_message       TEXT NOT NULL DEFAULT '',
  actor_id             TEXT REFERENCES users (owner_id),
  -- Set when the pipeline failed before any step ran, e.g. .gitflare/ci.ts is
  -- missing or did not produce a valid plan.
  error                TEXT NOT NULL DEFAULT '',

  created_at           INTEGER NOT NULL,
  started_at           INTEGER,
  finished_at          INTEGER
);
CREATE UNIQUE INDEX ci_runs_repo_number ON ci_runs (repo_id, number);
CREATE UNIQUE INDEX ci_runs_instance ON ci_runs (workflow_instance_id);
CREATE INDEX ci_runs_repo_sha ON ci_runs (repo_id, sha);
CREATE INDEX ci_runs_repo_created ON ci_runs (repo_id, created_at DESC);

CREATE TABLE ci_steps (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES ci_runs (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  command       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'success', 'failure', 'cancelled', 'cached')),
  exit_code     INTEGER NOT NULL DEFAULT 0,
  -- JSON array of step names this one waited on, from the emitted plan.
  needs         TEXT NOT NULL DEFAULT '[]',
  -- Workflow step attempt number; >1 means Workflows retried the command.
  attempt       INTEGER NOT NULL DEFAULT 1,
  cache_hit     INTEGER NOT NULL DEFAULT 0,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  started_at    INTEGER,
  finished_at   INTEGER
);
CREATE UNIQUE INDEX ci_steps_run_name ON ci_steps (run_id, name);
CREATE INDEX ci_steps_run ON ci_steps (run_id, ordinal);

CREATE TABLE releases (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  tag_name      TEXT NOT NULL,
  -- Branch or SHA the tag was cut from.
  target        TEXT NOT NULL DEFAULT '',
  name          TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  draft         INTEGER NOT NULL DEFAULT 0,
  prerelease    INTEGER NOT NULL DEFAULT 0,
  author_id     TEXT NOT NULL REFERENCES users (owner_id),
  created_at    INTEGER NOT NULL,
  published_at  INTEGER
);
CREATE UNIQUE INDEX releases_repo_tag ON releases (repo_id, tag_name);
CREATE INDEX releases_repo_created ON releases (repo_id, created_at DESC);

CREATE TABLE release_assets (
  id              TEXT PRIMARY KEY,
  release_id      TEXT NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- Key in the ASSETS_BUCKET R2 bucket.
  r2_key          TEXT NOT NULL,
  size            INTEGER NOT NULL DEFAULT 0,
  content_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
  download_count  INTEGER NOT NULL DEFAULT 0,
  -- 0 until the client finishes its PUT; incomplete assets are hidden and swept.
  uploaded        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX release_assets_release_name ON release_assets (release_id, name);

CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,
  -- Exactly one of these is set. An owner-level hook fires for every repo the
  -- owner has.
  repo_id       TEXT REFERENCES repos (id) ON DELETE CASCADE,
  owner_id      TEXT REFERENCES owners (id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'application/json',
  secret        TEXT NOT NULL DEFAULT '',
  -- JSON array of WebhookEvent names.
  events        TEXT NOT NULL DEFAULT '[]',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX webhooks_repo ON webhooks (repo_id) WHERE repo_id IS NOT NULL;
CREATE INDEX webhooks_owner ON webhooks (owner_id) WHERE owner_id IS NOT NULL;

CREATE TABLE webhook_deliveries (
  id             TEXT PRIMARY KEY,
  webhook_id     TEXT NOT NULL REFERENCES webhooks (id) ON DELETE CASCADE,
  event          TEXT NOT NULL,
  status_code    INTEGER NOT NULL DEFAULT 0,
  error          TEXT NOT NULL DEFAULT '',
  duration_ms    INTEGER NOT NULL DEFAULT 0,
  attempt        INTEGER NOT NULL DEFAULT 1,
  request_body   TEXT NOT NULL DEFAULT '',
  response_body  TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);
CREATE INDEX webhook_deliveries_hook ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('issue', 'pull_request', 'release', 'ci_run')),
  subject_id    TEXT NOT NULL,
  subject_title TEXT NOT NULL DEFAULT '',
  subject_ref   TEXT NOT NULL DEFAULT '',
  reason        TEXT NOT NULL,
  unread        INTEGER NOT NULL DEFAULT 1,
  url           TEXT NOT NULL DEFAULT '',
  updated_at    INTEGER NOT NULL
);
-- One row per user per subject: a new event on a thread the user already has
-- pending bumps the row instead of stacking duplicates.
CREATE UNIQUE INDEX notifications_user_subject ON notifications (user_id, subject_type, subject_id);
CREATE INDEX notifications_user_unread ON notifications (user_id, unread, updated_at DESC);

CREATE TABLE activity (
  id            TEXT PRIMARY KEY,
  actor_id      TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  repo_id       TEXT REFERENCES repos (id) ON DELETE CASCADE,
  owner_id      TEXT REFERENCES owners (id) ON DELETE CASCADE,
  action        TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  url           TEXT NOT NULL DEFAULT '',
  -- Copied from the repo at write time so public feeds can be filtered without
  -- joining, and so the entry stays hidden if a repo later goes private.
  is_public     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX activity_repo ON activity (repo_id, created_at DESC);
CREATE INDEX activity_actor ON activity (actor_id, created_at DESC);
CREATE INDEX activity_owner ON activity (owner_id, created_at DESC);
CREATE INDEX activity_public ON activity (is_public, created_at DESC);
