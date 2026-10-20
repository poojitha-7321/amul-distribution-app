-- Scanned PDFs are read by OCR in the background, so a file can be still processing or have failed.
ALTER TABLE assistant_files
  ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  ADD COLUMN error  TEXT;
