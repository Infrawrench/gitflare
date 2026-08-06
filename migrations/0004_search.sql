-- Full-text search indexes.
--
-- These are *contentless* FTS5 tables (`content=''`): only the tokenized terms
-- are stored, never the text. Two consequences drive everything below.
--
-- 1. Selecting a column back yields NULL. Always join to the base table on
--    rowid instead, and do filtering (visibility, repo scope) there:
--
--      SELECT r.* FROM repos_fts f
--      JOIN repos r ON r.rowid = f.rowid
--      WHERE repos_fts MATCH ?1 AND r.visibility = 'public'
--      ORDER BY rank
--
--    Storing repo_id or visibility as UNINDEXED columns here would not work —
--    they would read back NULL too. The join is the only way.
--
-- 2. The index cannot observe writes to its base table, so the triggers are
--    mandatory. Removing a row uses the 'delete' command form, which must be
--    given the *original* column values so FTS can work out which terms to
--    retract; a missed delete corrupts the index permanently.
--
-- Verified against local D1: insert, update, owner rename, and delete all keep
-- the index consistent with the base tables.
--
-- There is deliberately no code-search index. Blob contents live in Artifacts,
-- not D1, so SearchService walks the tree at query time (bounded, best-effort).

CREATE VIRTUAL TABLE repos_fts USING fts5 (
  name,
  description,
  -- Denormalized so "astrid/api" matches without a join at query time. Kept
  -- current by the owners rename trigger below.
  owner_login,
  content = '',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE issues_fts USING fts5 (
  title,
  body,
  content = '',
  -- Porter stemming so "pushing" matches a search for "push".
  tokenize = 'porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER issues_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER issues_fts_delete AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER issues_fts_update AFTER UPDATE OF title, body ON issues BEGIN
  INSERT INTO issues_fts (issues_fts, rowid, title, body)
  VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO issues_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER repos_fts_insert AFTER INSERT ON repos BEGIN
  INSERT INTO repos_fts (rowid, name, description, owner_login)
  VALUES (
    new.rowid,
    new.name,
    new.description,
    (SELECT login FROM owners WHERE id = new.owner_id)
  );
END;

CREATE TRIGGER repos_fts_delete AFTER DELETE ON repos BEGIN
  INSERT INTO repos_fts (repos_fts, rowid, name, description, owner_login)
  VALUES (
    'delete',
    old.rowid,
    old.name,
    old.description,
    (SELECT login FROM owners WHERE id = old.owner_id)
  );
END;

CREATE TRIGGER repos_fts_update AFTER UPDATE OF name, description ON repos BEGIN
  INSERT INTO repos_fts (repos_fts, rowid, name, description, owner_login)
  VALUES (
    'delete',
    old.rowid,
    old.name,
    old.description,
    (SELECT login FROM owners WHERE id = old.owner_id)
  );
  INSERT INTO repos_fts (rowid, name, description, owner_login)
  VALUES (
    new.rowid,
    new.name,
    new.description,
    (SELECT login FROM owners WHERE id = new.owner_id)
  );
END;

-- Renaming an owner would otherwise leave every one of their repos indexed under
-- the old login. Reindex them here rather than relying on callers to remember.
CREATE TRIGGER repos_fts_owner_rename AFTER UPDATE OF login ON owners BEGIN
  INSERT INTO repos_fts (repos_fts, rowid, name, description, owner_login)
  SELECT 'delete', r.rowid, r.name, r.description, old.login
  FROM repos r WHERE r.owner_id = old.id;

  INSERT INTO repos_fts (rowid, name, description, owner_login)
  SELECT r.rowid, r.name, r.description, new.login
  FROM repos r WHERE r.owner_id = new.id;
END;
