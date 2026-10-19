-- Amul Distributor & Retailer Order Management: initial schema

CREATE TABLE retailers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_name    TEXT,
  phone         TEXT,
  address       TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                    SERIAL PRIMARY KEY,
  email                 TEXT NOT NULL,
  name                  TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  role                  TEXT NOT NULL CHECK (role IN ('admin', 'retailer')),
  retailer_id           INTEGER REFERENCES retailers(id),
  active                BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN NOT NULL DEFAULT FALSE,
  password_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'retailer') = (retailer_id IS NOT NULL))
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE INDEX users_retailer_idx ON users (retailer_id);

CREATE TABLE categories (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT 'Amul',
  description TEXT,
  image_url   TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, brand, name)
);
CREATE INDEX products_category_idx ON products (category_id);

-- A variant is the orderable SKU. Stock is always counted in its stock_unit
-- (the base unit); a crate is a configured multiple of the base unit.
CREATE TABLE variants (
  id                 SERIAL PRIMARY KEY,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  variant_name       TEXT NOT NULL,
  sku                TEXT NOT NULL,
  pack_size          NUMERIC(10,3) NOT NULL CHECK (pack_size > 0),
  pack_size_unit     TEXT NOT NULL CHECK (pack_size_unit IN ('ml','l','g','kg','pcs')),
  stock_unit         TEXT NOT NULL DEFAULT 'packet'
                     CHECK (stock_unit IN ('packet','piece','box','litre','kg','g')),
  units_per_crate    INTEGER CHECK (units_per_crate IS NULL OR units_per_crate > 1),
  default_order_unit TEXT NOT NULL DEFAULT 'packet'
                     CHECK (default_order_unit IN ('packet','piece','box','litre','kg','g','crate')),
  price              NUMERIC(12,2) CHECK (price IS NULL OR price >= 0),
  crate_price        NUMERIC(12,2) CHECK (crate_price IS NULL OR crate_price >= 0),
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (default_order_unit <> 'crate' OR units_per_crate IS NOT NULL)
);
CREATE UNIQUE INDEX variants_sku_uq ON variants (upper(sku));
CREATE INDEX variants_product_idx ON variants (product_id);

CREATE TABLE inventory (
  variant_id      INTEGER PRIMARY KEY REFERENCES variants(id),
  opening_stock   INTEGER NOT NULL DEFAULT 0 CHECK (opening_stock >= 0),
  physical_stock  INTEGER NOT NULL DEFAULT 0 CHECK (physical_stock >= 0),
  reserved_stock  INTEGER NOT NULL DEFAULT 0 CHECK (reserved_stock >= 0),
  min_stock       INTEGER NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reserved_stock <= physical_stock)
);

CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id               SERIAL PRIMARY KEY,
  order_number     TEXT NOT NULL UNIQUE,
  retailer_id      INTEGER NOT NULL REFERENCES retailers(id),
  placed_by        INTEGER NOT NULL REFERENCES users(id),
  delivery_date    DATE NOT NULL,
  status           TEXT NOT NULL CHECK (status IN
                   ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_DELIVERY',
                    'PARTIALLY_DELIVERED','DELIVERED','REJECTED','CANCELLED')),
  notes            TEXT,
  total_amount     NUMERIC(14,2),
  delivered_amount NUMERIC(14,2),
  submit_token     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX orders_submit_token_uq ON orders (retailer_id, submit_token) WHERE submit_token IS NOT NULL;
CREATE INDEX orders_retailer_idx ON orders (retailer_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_delivery_date_idx ON orders (delivery_date);

-- Product details are copied onto the item so history never changes later.
CREATE TABLE order_items (
  id                   SERIAL PRIMARY KEY,
  order_id             INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id           INTEGER NOT NULL REFERENCES variants(id),
  product_name         TEXT NOT NULL,
  variant_name         TEXT NOT NULL,
  category_name        TEXT NOT NULL,
  sku                  TEXT NOT NULL,
  pack_label           TEXT NOT NULL,
  stock_unit           TEXT NOT NULL,
  order_unit           TEXT NOT NULL,
  units_per_order_unit INTEGER NOT NULL CHECK (units_per_order_unit >= 1),
  quantity             INTEGER NOT NULL CHECK (quantity > 0),
  base_quantity        INTEGER NOT NULL CHECK (base_quantity > 0),
  unit_price           NUMERIC(12,2),
  line_total           NUMERIC(14,2),
  reserved_base_qty    INTEGER NOT NULL DEFAULT 0 CHECK (reserved_base_qty >= 0),
  delivered_quantity   INTEGER NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
  delivered_base_qty   INTEGER NOT NULL DEFAULT 0 CHECK (delivered_base_qty >= 0),
  UNIQUE (order_id, variant_id, order_unit)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_variant_idx ON order_items (variant_id);

CREATE TABLE order_status_history (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX osh_order_idx ON order_status_history (order_id);

-- One delivery confirmation per order (unique order_id): duplicates are impossible.
CREATE TABLE deliveries (
  id              SERIAL PRIMARY KEY,
  order_id        INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  confirmed_by    INTEGER NOT NULL REFERENCES users(id),
  note            TEXT,
  delivered_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delivery_items (
  id                   SERIAL PRIMARY KEY,
  delivery_id          INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  order_item_id        INTEGER NOT NULL REFERENCES order_items(id),
  delivered_quantity   INTEGER NOT NULL CHECK (delivered_quantity >= 0),
  delivered_base_qty   INTEGER NOT NULL CHECK (delivered_base_qty >= 0),
  undelivered_base_qty INTEGER NOT NULL CHECK (undelivered_base_qty >= 0)
);

-- Every change to physical or reserved stock is recorded here.
CREATE TABLE inventory_transactions (
  id               BIGSERIAL PRIMARY KEY,
  variant_id       INTEGER NOT NULL REFERENCES variants(id),
  type             TEXT NOT NULL CHECK (type IN
                   ('OPENING','RESERVE','RELEASE','DELIVERY','ADJUSTMENT','RETURN','RETURN_DAMAGED','DAMAGED')),
  physical_delta   INTEGER NOT NULL DEFAULT 0,
  reserved_delta   INTEGER NOT NULL DEFAULT 0,
  physical_after   INTEGER NOT NULL,
  reserved_after   INTEGER NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 0,
  order_id         INTEGER REFERENCES orders(id),
  delivery_id      INTEGER REFERENCES deliveries(id),
  retailer_id      INTEGER REFERENCES retailers(id),
  reason           TEXT,
  user_id          INTEGER REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX itx_variant_idx ON inventory_transactions (variant_id, created_at DESC);
CREATE INDEX itx_order_idx ON inventory_transactions (order_id);
CREATE INDEX itx_created_idx ON inventory_transactions (created_at);

CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT,
  details    JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_logs (entity, entity_id);
CREATE INDEX audit_created_idx ON audit_logs (created_at);

CREATE TABLE notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INTEGER REFERENCES users(id),
  for_admins  BOOLEAN NOT NULL DEFAULT FALSE,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_by     INTEGER[] NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR for_admins)
);
CREATE INDEX notif_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX notif_admin_idx ON notifications (for_admins, created_at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES
  ('insufficient_stock_policy', 'block'),
  ('retailer_cancel_until', 'ACCEPTED'),
  ('max_delivery_days_ahead', '14');
