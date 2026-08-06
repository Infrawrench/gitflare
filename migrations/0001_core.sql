-- Core identity, ownership, and repository metadata.
--
-- Git objects live in Cloudflare Artifacts, not here. This schema stores only
-- what Artifacts has no concept of: who owns what, who may read or write it,
-- and the forge-level metadata (visibility, stars, forks) layered on top.

-- A "namespace" row: every owner is either a user or an org, and repo names are
-- unique within one. Keeping both in one table lets `owner/repo` resolve with a
-- single lookup and gives us one ID space for foreign keys.
CREATE TABLE owners (
  id            TEXT PRIMARY KEY,
  login         TEXT NOT NULL,
  -- Case-insensitive uniqueness without losing the display casing.
  login_lower   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('user', 'org')),
  display_name  TEXT NOT NULL DEFAULT '',
  description    TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  visibility    TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX owners_login_lower ON owners (login_lower);

CREATE TABLE users (
  owner_id      TEXT PRIMARY KEY REFERENCES owners (id) ON DELETE CASCADE,
  email         TEXT NOT NULL DEFAULT '',
  email_lower   TEXT NOT NULL DEFAULT '',
  -- Cloudflare Access subject claim ("sub"). Null until the user first signs in
  -- through Access; local dev sessions leave it null.
  access_sub    TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_seen_at  INTEGER
);
CREATE UNIQUE INDEX users_access_sub ON users (access_sub) WHERE access_sub IS NOT NULL;
CREATE INDEX users_email_lower ON users (email_lower);

-- Browser sessions. Only a hash of the cookie value is stored, so a database
-- leak cannot be replayed as a login.
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL,
  user_agent    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX sessions_token_hash ON sessions (token_hash);
CREATE INDEX sessions_user ON sessions (user_id, expires_at);

-- Personal access tokens. These authenticate git-over-HTTPS (as the Basic auth
-- password) and the Connect API, both of which cannot complete an interactive
-- Access login.
CREATE TABLE access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  -- First 8 characters of the plaintext, shown in the UI so a user can tell
  -- their tokens apart without us storing the secret.
  prefix        TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  last_used_at  INTEGER
);
CREATE UNIQUE INDEX access_tokens_hash ON access_tokens (token_hash);
CREATE INDEX access_tokens_user ON access_tokens (user_id);

CREATE TABLE ssh_keys (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  public_key    TEXT NOT NULL,
  -- SHA256 base64 of the raw key blob, matching `ssh-keygen -lf` output. The
  -- SSH container looks keys up by this.
  fingerprint   TEXT NOT NULL,
  key_type      TEXT NOT NULL DEFAULT '',
  read_only     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE UNIQUE INDEX ssh_keys_fingerprint ON ssh_keys (fingerprint);
CREATE INDEX ssh_keys_user ON ssh_keys (user_id);

CREATE TABLE org_members (
  org_id        TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  role          TEXT NOT NULL CHECK (role IN ('member', 'owner')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members (user_id);

CREATE TABLE teams (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  name_lower         TEXT NOT NULL,
  description        TEXT NOT NULL DEFAULT '',
  permission         TEXT NOT NULL CHECK (permission IN ('read', 'triage', 'write', 'maintain', 'admin')),
  -- When set, the team's permission applies to every repo in the org, including
  -- repos created after the team, so team_repos rows are not needed.
  includes_all_repos INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX teams_org_name ON teams (org_id, name_lower);

CREATE TABLE team_members (
  team_id       TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE repos (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES owners (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  name_lower        TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  visibility        TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'private')),
  default_branch    TEXT NOT NULL DEFAULT 'main',

  -- The flat repo name inside the Artifacts namespace. Artifacts has no
  -- directory structure, so "owner/repo" is encoded as "owner--repo".
  artifacts_name    TEXT NOT NULL,
  -- 'ready' | 'importing' | 'forking' | 'error', mirroring the Artifacts repo
  -- status. Git routes reject anything but 'ready'.
  status            TEXT NOT NULL DEFAULT 'ready',
  status_error      TEXT NOT NULL DEFAULT '',

  is_fork           INTEGER NOT NULL DEFAULT 0,
  parent_repo_id    TEXT REFERENCES repos (id) ON DELETE SET NULL,
  is_mirror         INTEGER NOT NULL DEFAULT 0,
  mirror_source_url TEXT NOT NULL DEFAULT '',

  archived          INTEGER NOT NULL DEFAULT 0,
  has_wiki          INTEGER NOT NULL DEFAULT 1,
  has_issues        INTEGER NOT NULL DEFAULT 1,
  ci_enabled        INTEGER NOT NULL DEFAULT 1,

  -- Issues and pull requests draw from one counter so #1 identifies exactly one
  -- thing. Incremented with `UPDATE ... RETURNING` to stay atomic.
  next_number       INTEGER NOT NULL DEFAULT 1,
  next_run_number   INTEGER NOT NULL DEFAULT 1,

  star_count        INTEGER NOT NULL DEFAULT 0,
  fork_count        INTEGER NOT NULL DEFAULT 0,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  pushed_at         INTEGER
);
CREATE UNIQUE INDEX repos_owner_name ON repos (owner_id, name_lower);
CREATE UNIQUE INDEX repos_artifacts_name ON repos (artifacts_name);
CREATE INDEX repos_parent ON repos (parent_repo_id);
CREATE INDEX repos_visibility_updated ON repos (visibility, updated_at DESC);

CREATE TABLE repo_collaborators (
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  permission    TEXT NOT NULL CHECK (permission IN ('read', 'triage', 'write', 'maintain', 'admin')),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX repo_collaborators_user ON repo_collaborators (user_id);

-- Grants a team's permission on one repo. Teams with includes_all_repos skip
-- this table entirely.
CREATE TABLE team_repos (
  team_id       TEXT NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (team_id, repo_id)
);
CREATE INDEX team_repos_repo ON team_repos (repo_id);

CREATE TABLE stars (
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX stars_user ON stars (user_id, created_at DESC);

CREATE TABLE watches (
  repo_id       TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users (owner_id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX watches_user ON watches (user_id);
