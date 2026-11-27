-- Candidate fix: the scheduler authenticates with service_role and must read
-- the feature flag. Keep all writes and anonymous/authenticated table access
-- revoked; end users read the flag only through agenda_sync_enabled().
-- Tested in the disposable project only; do not apply to production without
-- completing the rollout checks and explicit approval.
grant select on public.agenda_sync_control to service_role;
