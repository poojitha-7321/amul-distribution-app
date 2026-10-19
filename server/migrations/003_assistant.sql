-- AI assistant: uploaded files (copies live in Google Drive), parsed data, chat history

CREATE TABLE assistant_files (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  mime_type       TEXT,
  kind            TEXT NOT NULL CHECK (kind IN ('table', 'text')),
  size_bytes      INTEGER NOT NULL,
  drive_file_id   TEXT,
  drive_link      TEXT,
  tables          JSONB,          -- [{ name, columns:[{name,type}], rows:[[...]], truncated }]
  text_content    TEXT,
  row_count       INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,
  uploaded_by     INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_files_created_idx ON assistant_files (created_at DESC);

CREATE TABLE assistant_threads (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_threads_user_idx ON assistant_threads (user_id, updated_at DESC);

CREATE TABLE assistant_messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   INTEGER NOT NULL REFERENCES assistant_threads(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content     TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assistant_messages_thread_idx ON assistant_messages (thread_id, id);
