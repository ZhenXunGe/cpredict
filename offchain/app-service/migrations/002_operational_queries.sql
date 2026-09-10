BEGIN;
CREATE INDEX IF NOT EXISTS app_feedback_received ON app_feedback(received_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS app_feedback_operation ON app_feedback(operation_id,received_at DESC,id DESC) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS app_operations_oldest_pending ON app_operations(created_at) WHERE state IN ('submitted','confirming','unknown');
COMMIT;
