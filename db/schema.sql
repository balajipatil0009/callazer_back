-- ============================================================
-- ENUM
-- ============================================================
CREATE TYPE call_type AS ENUM (
    'incoming',
    'outgoing',
    'missed',
    'rejected',
    'not_pickup',
    'unknown'
);

-- ============================================================
-- CLIENTS
-- ============================================================
CREATE TABLE clients (
    id SERIAL PRIMARY KEY,
    client_name VARCHAR(100),
    client_phone VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================
-- EMPLOYEES
-- ============================================================
CREATE TABLE employees (
    employee_code VARCHAR(50) PRIMARY KEY,
    employee_name VARCHAR(100) NOT NULL,
    employee_phone VARCHAR(20),
    model_name VARCHAR(100),
    app_version VARCHAR(20),
    registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_call_at TIMESTAMP,
    last_sync_at TIMESTAMP
);

-- ============================================================
-- CALLS
-- ============================================================
CREATE TABLE calls (
    id SERIAL PRIMARY KEY,
    employee_code VARCHAR(50) NOT NULL REFERENCES employees(employee_code),
    employee_phone VARCHAR(20) NOT NULL,
    client_phone VARCHAR(20) NOT NULL REFERENCES clients(client_phone),
    start_at TIMESTAMP NOT NULL,
    duration INTEGER NOT NULL DEFAULT 0,
    type call_type NOT NULL,
    is_unique BOOLEAN NOT NULL DEFAULT FALSE,
    device_call_id BIGINT NOT NULL,
    synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_calls_dedup UNIQUE (employee_code, device_call_id)
);

-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_calls_employee ON calls(employee_code);
CREATE INDEX idx_calls_start_at ON calls(start_at DESC);
CREATE INDEX idx_calls_employee_time ON calls(employee_code, start_at DESC);
CREATE INDEX idx_calls_client_phone ON calls(client_phone);
CREATE INDEX idx_calls_type ON calls(type);
CREATE INDEX idx_calls_unique ON calls(start_at DESC) WHERE is_unique = TRUE;
CREATE INDEX idx_employees_last_sync ON employees(last_sync_at);
