# Unsupported requirements — say so, cite the clause

| Requirement | Status | Interim pattern that conforms | Cite |
|---|---|---|---|
| Marking a `human` clause `pass` from an AI run | forbidden | `manual-review` with the checklist for a person | [PAS-OPS-019](https://docs.proappstore.online/standard/ops/#pas-ops-019), [PAS-AUTH-020](https://docs.proappstore.online/standard/auth/#pas-auth-020) |
| Treating green CI, unit or smoke runs as evidence for a Security clause or for production | forbidden | cite a test only under the clause whose assertion it implements | [PAS-OPS-001](https://docs.proappstore.online/standard/ops/#pas-ops-001) |
| Proposing a substitute the standard forbids (a third-party identity provider, an own Worker, an external database) as remediation | forbidden | the finding says the clause cannot be met inside the platform, is flagged for human validation, and points at a platform issue | [PAS-STACK-024](https://docs.proappstore.online/standard/stack/#pas-stack-024) |
| Auditing from a remembered standard, or an older version | not allowed | fetch standard.json and record its version | [governance](https://docs.proappstore.online/standard/governance/) |
| Raising a clause's severity without human validation | not allowed | keep the default; note the concern | [audit model](https://docs.proappstore.online/standard/audit-model/) |
| Creating issues in read-only mode, or without the duplicate check | not allowed | produce the report; open issues only when asked, after searching for the dedupe key | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
| Auditing `pas check` alone as the audit | not enough | the checks are hygiene scans, partially automated evidence at most; the chapters still have to be read | [audit model](https://docs.proappstore.online/standard/audit-model/) |
| Quoting secrets, tokens or personal data as evidence | forbidden | cite the path and the observation only | [PAS-OPS-011](https://docs.proappstore.online/standard/ops/#pas-ops-011) |
| Skipping a clause because it "obviously" passes or does not apply | not allowed | one result per clause, with evidence or the not-applicable reason | [audit instructions](https://docs.proappstore.online/standard/audit-instructions/) |
