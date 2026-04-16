-- Add field-staff phone for web directory (updated on each successful sync batch).
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS employee_phone VARCHAR(20);
