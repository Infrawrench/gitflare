-- Issue tracker and pull requests.
--
-- Issues and pull requests share the `issues` table and one per-repo number
-- sequence, the way Gitea and GitHub both behave: #12 is either an issue or a
-- pull request, never both. Pull-request-only columns live in `pull_requests`,
-- keyed by the same issue id.

CREATE TABLE labels (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  name_lower    TEXT NOT NULL,
  -- Six hex digits, no leading '#'.
  color         TEXT NOT NULL DEFAULT '888888',
  description   TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX labels_repo_name ON labels (repo_id, name_lower);

CREATE TABLE milestones (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  due_on        INTEGER,
  created_at    INTEGER NOT NULL,
  closed_at     INTEGER
);
CREATE INDEX milestones_repo ON milestones (repo_id, state);

CREATE TABLE issues (
  id             TEXT PRIMARY KEY,
  repo_id        TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  number         INTEGER NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  author_id      TEXT NOT NULL REFERENCES users (owner_id),
  milestone_id   TEXT REFERENCES milestones (id) ON DELETE SET NULL,
  -- Discriminator for the shared number sequence. Pull-request rows also have a
  -- matching row in `pull_requests`.
  is_pull        INTEGER NOT NULL DEFAULT 0,
  locked         INTEGER NOT NULL DEFAULT 0,
  comment_count  INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  closed_at      INTEGER
);
CREATE UNIQUE INDEX issues_repo_number ON issues (repo_id, number);
CREATE INDEX issues_repo_state ON issues (repo_id, is_pull, state, updated_at DESC);
CREATE INDEX issues_author ON issues (author_id, updated_at DESC);
CREATE INDEX issues_milestone ON issues (milestone_id);

CREATE TABLE issue_labels (
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  label_id      TEXT NOT NULL REFERENCES labels (id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX issue_labels_label ON issue_labels (label_id);

CREATE TABLE issue_assignees (
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX issue_assignees_user ON issue_assignees (user_id);

CREATE TABLE comments (
  id            TEXT PRIMARY KEY,
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users (owner_id),
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  edited        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comments_issue ON comments (issue_id, created_at);

CREATE TABLE pull_requests (
  issue_id           TEXT PRIMARY KEY REFERENCES issues (id) ON DELETE CASCADE,
  repo_id            TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,

  base_branch        TEXT NOT NULL,
  -- Recorded when the PR was opened or last synced; the live SHA is read from
  -- Artifacts on every request, since either branch can move underneath us.
  base_sha           TEXT NOT NULL DEFAULT '',
  -- Null for a same-repo pull request; set when the head lives in a fork.
  head_repo_id       TEXT REFERENCES repos (id) ON DELETE SET NULL,
  head_branch        TEXT NOT NULL,
  head_sha           TEXT NOT NULL DEFAULT '',

  draft              INTEGER NOT NULL DEFAULT 0,
  merged             INTEGER NOT NULL DEFAULT 0,
  merged_at          INTEGER,
  merged_by_id       TEXT REFERENCES users (owner_id),
  merge_commit_sha   TEXT NOT NULL DEFAULT '',
  merge_method       TEXT
);
CREATE INDEX pull_requests_repo_base ON pull_requests (repo_id, base_branch);
CREATE INDEX pull_requests_head ON pull_requests (head_repo_id, head_branch);

CREATE TABLE pull_reviewers (
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  requested_at  INTEGER NOT NULL,
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX pull_reviewers_user ON pull_reviewers (user_id);

CREATE TABLE reviews (
  id            TEXT PRIMARY KEY,
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users (owner_id),
  state         TEXT NOT NULL CHECK (state IN ('commented', 'approved', 'changes_requested')),
  body          TEXT NOT NULL DEFAULT '',
  -- Head SHA the review was written against. Later pushes mark its inline
  -- comments outdated rather than deleting them.
  commit_sha    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX reviews_issue ON reviews (issue_id, created_at);

CREATE TABLE review_comments (
  id            TEXT PRIMARY KEY,
  review_id     TEXT NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users (owner_id),
  body          TEXT NOT NULL,
  path          TEXT NOT NULL,
  -- Line on the head side. 0 means the comment applies to the file as a whole.
  line          INTEGER NOT NULL DEFAULT 0,
  commit_sha    TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX review_comments_issue ON review_comments (issue_id, path, line);
