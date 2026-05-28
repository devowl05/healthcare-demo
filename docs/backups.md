# Backups and GDPR-replay policy

This document describes the production backup posture for the Healthcare Agent, the restore protocol that re-applies pending GDPR deletes after any restore, and what is explicitly out of scope for this implementation.

---

## Production backup posture

The reference deployment assumes a managed Postgres (RDS, Cloud SQL, or equivalent) with the following defaults:

- **Encrypted at rest** using AES-256 with a managed key (KMS or equivalent). Snapshots inherit the encryption of the source volume.
- **30-day rotation.** Daily snapshots are retained for 30 days; older snapshots are evicted.
- **No hot-restore of deleted user data.** A backup taken *before* a user issued `DELETE /api/users/me` will still contain that user's rows. Operators must run the GDPR-replay job (below) after every restore to bring the database back into compliance with the user's deletion request.
- **TTS cache and exports are not backed up.** They are derived data (TTS is regenerable; exports have a 24-hour signed URL and a one-time download intent). The `tts_data` and `exports` Compose volumes are explicitly excluded from any backup rotation.

The audit log is included in the database backup. Because the audit log uses SHA-256 row-hash chaining, restoring from a snapshot is sufficient to preserve chain integrity — no separate audit-archive restore is needed.

---

## Restore protocol

Whenever the database is restored from a backup:

1. **Bring the API down** or put it in maintenance mode so no new writes land between the restore and the replay.
2. Restore the snapshot following the managed provider's procedure.
3. **Run the GDPR-replay job** to re-apply any pending deletes recorded since the snapshot was taken:

   ```bash
   bun run src/jobs/replay-deletions.ts
   ```

   The job reads `gdpr.delete_requested` audit entries from a tamper-evident external log (or, in absence of one, from the most recent backup *plus* an append-only stream of deletion events) and re-issues the deletes against the restored database. **In this implementation the job is a stub** — the production-grade version requires either a deletion-event side-channel (e.g. an SNS topic or an append-only object-store log) that survives the database restore, or a manual reconciliation step against the support ticket system. Full implementation is deferred.
4. Verify the audit chain end-to-end by running `bun run src/jobs/audit-chain-verify.ts`. It walks from `audit_chain_checkpoints` forward and reports any hash mismatch.
5. Bring the API back up.

Document the restore in your incident log, including the snapshot timestamp and the count of replayed deletions.

---

## Local development

Backups are **not** configured locally. The `pgdata` Compose volume is the only copy of any data you create in dev; wiping it (`docker compose down -v`) loses everything. If you need a known-good state for dev, snapshot the volume manually with `docker run --rm -v healthcare-demo_pgdata:/data -v $PWD:/backup alpine tar czf /backup/pgdata.tgz /data` and restore with the inverse.

The `migrate` Compose service is idempotent; rerunning it against an existing database is a no-op.

---

## Disaster recovery scope

A full DR plan — RTO/RPO targets, cross-region replication, regular restore drills, multi-region failover playbooks — is **out of scope** for this implementation. The posture documented above is sufficient for the demo and for HIPAA-adjacent operation in a single-region deployment. Productionizing into a regulated environment requires:

- A documented RTO/RPO with sign-off from the operator.
- Cross-region replication (logical or physical).
- Quarterly restore drills with a written runbook.
- A tamper-evident external deletion log so the GDPR-replay job can run unattended.

These are recorded here for posterity and to make the deferred work explicit.
