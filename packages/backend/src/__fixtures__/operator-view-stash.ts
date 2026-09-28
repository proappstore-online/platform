/** Stash, the first sample app declaring the operator-view contract (#240). */
const operator = (reason: string) => ({ app_roles: ['operator'], caller_unscoped: { reason } });

/**
 * Stash: cross-pocket members, problem reports with a review workflow, a
 * suspension history per member, suspend (destructive, step-up) and lift, and
 * an identity-check (KYC) queue with ID-document and selfie evidence.
 */
export const STASH = {
  tools: [
    {
      name: 'op_list_users', description: 'Every member across pockets', operation: 'query', requires_auth: true,
      params: { q: { type: 'string', optional: true }, after: { type: 'string', optional: true } },
      sql: "SELECT m.id AS user_id, m.display_name, m.created_at, m.suspended FROM members m WHERE (:q IS NULL OR m.display_name LIKE '%' || :q || '%') AND (:after IS NULL OR m.id > :after) ORDER BY m.id LIMIT 50",
      auth: operator('Operators see every member across pockets.'),
    },
    {
      // Selects password_hash on purpose: the detail declares fewer fields, and only those may leave the platform.
      name: 'op_member_detail', description: 'One member', operation: 'query', requires_auth: true,
      params: { user_id: { type: 'string' } },
      sql: 'SELECT m.id AS user_id, m.display_name, m.email, m.pocket_count, m.created_at, m.password_hash FROM members m WHERE m.id = :user_id LIMIT 1',
      auth: operator('Operators open any member.'),
    },
    {
      name: 'op_list_reports', description: 'Problem reports', operation: 'query', requires_auth: true,
      params: { status: { type: 'string', optional: true }, q: { type: 'string', optional: true }, after: { type: 'string', optional: true } },
      sql: "SELECT r.id AS report_id, r.reported_user_id, r.reason, r.status, r.created_at FROM reports r WHERE (:status IS NULL OR r.status = :status) AND (:q IS NULL OR r.reason LIKE '%' || :q || '%') AND (:after IS NULL OR r.id > :after) ORDER BY r.id LIMIT 100",
      auth: operator('Operators triage every report.'),
    },
    {
      name: 'op_report_detail', description: 'One report', operation: 'query', requires_auth: true,
      params: { report_id: { type: 'string' } },
      sql: 'SELECT r.id AS report_id, r.reason, r.details, r.reporter_id, r.reported_user_id, r.status, r.created_at FROM reports r WHERE r.id = :report_id LIMIT 1',
      auth: operator('Operators open any report.'),
    },
    {
      name: 'op_report_metrics', description: 'Moderation KPIs', operation: 'query', requires_auth: true, params: {},
      sql: "SELECT COUNT(*) AS open_reports, (SELECT COUNT(*) FROM members WHERE suspended = 1) AS suspended_users FROM reports WHERE status = 'open'",
      auth: operator('App-wide moderation counts.'),
    },
    {
      name: 'op_list_suspensions', description: 'Suspension history', operation: 'query', requires_auth: true,
      params: { user: { type: 'string', optional: true }, after: { type: 'string', optional: true } },
      sql: 'SELECT s.id AS suspension_id, s.user_id, s.reason, s.status, s.created_at, s.lifted_at FROM suspensions s WHERE (:user IS NULL OR s.user_id = :user) AND (:after IS NULL OR s.id > :after) ORDER BY s.id LIMIT 100',
      auth: operator('Operators see every suspension.'),
    },
    {
      name: 'op_suspend_user', description: 'Suspend a member', operation: 'batch', requires_auth: true, step_up: true,
      params: { user_id: { type: 'string' } },
      statements: [
        'UPDATE members SET suspended = 1 WHERE id = :user_id AND suspended = 0',
        "INSERT INTO suspensions (id, user_id, reason, status, created_at, created_by) VALUES (:__uuid, :user_id, 'operator', 'active', :__now, :__user_id)",
      ],
      auth: operator('Operators suspend any member.'),
    },
    {
      name: 'op_lift_suspension', description: 'Lift a suspension', operation: 'batch', requires_auth: true,
      params: { suspension_id: { type: 'string' }, from_status: { type: 'string' }, user_id: { type: 'string' } },
      statements: [
        "UPDATE suspensions SET status = 'lifted', lifted_at = :__now, lifted_by = :__user_id WHERE id = :suspension_id AND status = :from_status",
        'UPDATE members SET suspended = 0 WHERE id = :user_id',
      ],
      auth: operator('Operators lift any suspension.'),
    },
    {
      name: 'op_daily_signups', description: 'Daily sign-ups by plan', operation: 'query', requires_auth: true,
      params: { from: { type: 'string', optional: true }, to: { type: 'string', optional: true } },
      sql: 'SELECT d.day, d.plan, d.signups FROM daily_signups d WHERE d.day >= :from AND d.day <= :to ORDER BY d.day LIMIT 3000',
      auth: operator('App-wide daily sign-up counts.'),
    },
    {
      name: 'op_list_kyc', description: 'Identity checks', operation: 'query', requires_auth: true,
      params: { status: { type: 'string', optional: true }, q: { type: 'string', optional: true }, after: { type: 'string', optional: true } },
      sql: "SELECT k.request_id, k.full_name, k.document_type, k.status, k.submitted_at FROM kyc_requests k WHERE (:status IS NULL OR k.status = :status) AND (:q IS NULL OR k.full_name LIKE '%' || :q || '%') AND (:after IS NULL OR k.request_id > :after) ORDER BY k.request_id LIMIT 50",
      auth: operator('Operators review every identity check.'),
    },
    {
      // Selects internal_score on purpose: it is not a declared field, so it never leaves the platform.
      name: 'op_kyc_detail', description: 'One identity check', operation: 'query', requires_auth: true, step_up: true,
      params: { request_id: { type: 'string' } },
      sql: 'SELECT k.request_id, k.user_id, k.full_name, k.document_type, k.status, k.submitted_at, k.document_path, k.selfie_path, k.internal_score FROM kyc_requests k WHERE k.request_id = :request_id LIMIT 1',
      auth: operator('Operators open any identity check.'),
    },
    ...(['approve', 'reject'] as const).map((verb) => ({
      name: `op_${verb}_kyc`, description: `${verb} an identity check`, operation: 'execute', requires_auth: true, step_up: true,
      params: { request_id: { type: 'string' }, from_status: { type: 'string' } },
      sql: `UPDATE kyc_requests SET status = '${verb === 'approve' ? 'approved' : 'rejected'}', decided_by = :__user_id, decided_at = :__now WHERE request_id = :request_id AND status = :from_status`,
      auth: { app_roles: ['operator'] },
    })),
    ...(['review', 'resolve', 'dismiss'] as const).map((verb) => ({
      name: `op_${verb}_report`, description: `${verb} a report`, operation: 'execute', requires_auth: true,
      params: { report_id: { type: 'string' }, from_status: { type: 'string' } },
      sql: `UPDATE reports SET status = '${{ review: 'reviewing', resolve: 'resolved', dismiss: 'dismissed' }[verb]}', reviewer_id = :__user_id WHERE id = :report_id AND status = :from_status`,
      auth: { app_roles: ['operator'] },
    })),
  ],
  operator_view: {
    version: 1,
    resources: [
      {
        id: 'members', kind: 'users', title: 'Members', action: 'op_list_users',
        columns: [
          { key: 'display_name', label: 'Name' },
          { key: 'user_id', label: 'User ID' },
          { key: 'created_at', label: 'Joined', format: 'datetime' },
          { key: 'suspended', label: 'Suspended', format: 'boolean' },
        ],
        search: { param: 'q' },
        page: { param: 'after', column: 'user_id' },
        detail: {
          action: 'op_member_detail', param: 'user_id', key: 'user_id',
          fields: [
            { key: 'display_name', label: 'Name' },
            { key: 'user_id', label: 'User ID' },
            { key: 'email', label: 'Email' },
            { key: 'pocket_count', label: 'Pockets', format: 'number' },
            { key: 'created_at', label: 'Joined', format: 'datetime' },
          ],
        },
      },
      {
        id: 'open_reports', kind: 'reports', title: 'Reports', description: 'Problem reports from members.', action: 'op_list_reports',
        columns: [
          { key: 'reason', label: 'Reason' },
          { key: 'reported_user_id', label: 'Reported user' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'created_at', label: 'Filed', format: 'datetime' },
          { key: 'report_id', label: 'Report' },
        ],
        search: { param: 'q' },
        page: { param: 'after', column: 'report_id' },
        status: {
          column: 'status', param: 'status',
          states: [
            { value: 'open', label: 'Open' },
            { value: 'reviewing', label: 'In review' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'dismissed', label: 'Dismissed' },
          ],
        },
        detail: {
          action: 'op_report_detail', param: 'report_id', key: 'report_id',
          fields: [
            { key: 'reason', label: 'Reason' },
            { key: 'details', label: 'Details' },
            { key: 'reporter_id', label: 'Reported by' },
            { key: 'reported_user_id', label: 'Reported user' },
            { key: 'status', label: 'Status', format: 'badge' },
            { key: 'created_at', label: 'Filed', format: 'datetime' },
          ],
        },
      },
      {
        id: 'suspension_history', kind: 'suspensions', title: 'Suspensions', action: 'op_list_suspensions',
        columns: [
          { key: 'user_id', label: 'User' },
          { key: 'reason', label: 'Reason' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'created_at', label: 'Suspended', format: 'datetime' },
          { key: 'lifted_at', label: 'Lifted', format: 'datetime' },
          { key: 'suspension_id', label: 'Suspension' },
        ],
        page: { param: 'after', column: 'suspension_id' },
        related: { resource: 'members', param: 'user' },
        status: { column: 'status', states: [{ value: 'active', label: 'Active' }, { value: 'lifted', label: 'Lifted' }] },
      },
      {
        id: 'kyc', kind: 'verification', title: 'Identity checks', action: 'op_list_kyc',
        columns: [
          { key: 'full_name', label: 'Name' },
          { key: 'document_type', label: 'Document' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'submitted_at', label: 'Submitted', format: 'datetime' },
          { key: 'request_id', label: 'Request' },
        ],
        search: { param: 'q' },
        page: { param: 'after', column: 'request_id' },
        status: {
          column: 'status', param: 'status',
          states: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }],
        },
        detail: {
          action: 'op_kyc_detail', param: 'request_id', key: 'request_id',
          fields: [
            { key: 'full_name', label: 'Name' },
            { key: 'user_id', label: 'User' },
            { key: 'document_type', label: 'Document' },
            { key: 'status', label: 'Status', format: 'badge' },
            { key: 'submitted_at', label: 'Submitted', format: 'datetime' },
            { key: 'request_id', label: 'Request' },
            { key: 'document_path', label: 'ID document' },
            { key: 'selfie_path', label: 'Selfie' },
          ],
          evidence: [{ field: 'document_path', label: 'ID document' }, { field: 'selfie_path', label: 'Selfie' }],
        },
      },
      {
        id: 'moderation', kind: 'metrics', title: 'Moderation', action: 'op_report_metrics',
        columns: [
          { key: 'open_reports', label: 'Open reports', format: 'number' },
          { key: 'suspended_users', label: 'Suspended', format: 'number' },
        ],
      },
      {
        id: 'growth', kind: 'metrics', title: 'Sign-ups', action: 'op_daily_signups',
        columns: [
          { key: 'day', label: 'Day', format: 'datetime' },
          { key: 'plan', label: 'Plan' },
          { key: 'signups', label: 'Sign-ups', format: 'number' },
        ],
        series: {
          time: { column: 'day', grain: 'day' },
          range: { from_param: 'from', to_param: 'to', default_days: 30, max_days: 366 },
          measures: [{ column: 'signups', label: 'Sign-ups', unit: 'count', aggregation: 'sum' }],
          dimension: { column: 'plan', label: 'Plan', max_values: 3 },
        },
      },
    ],
    actions: [
      { id: 'suspend_member', title: 'Suspend', resource: 'members', action: 'op_suspend_user', params: { user_id: 'user_id' }, confirm: 'Suspend this member?', destructive: true },
      { id: 'suspend_reported', title: 'Suspend user', resource: 'open_reports', action: 'op_suspend_user', params: { user_id: 'reported_user_id' }, confirm: 'Suspend the reported user?', destructive: true },
      {
        id: 'review', title: 'Start review', resource: 'open_reports', action: 'op_review_report', target: 'report_id',
        params: { report_id: 'report_id', from_status: 'status' }, confirm: 'Start reviewing this report?',
        transition: { from: ['open'], to: 'reviewing' },
      },
      {
        id: 'resolve', title: 'Resolve', resource: 'open_reports', action: 'op_resolve_report', target: 'report_id',
        params: { report_id: 'report_id', from_status: 'status' }, confirm: 'Mark this report resolved?',
        transition: { from: ['open', 'reviewing'], to: 'resolved' },
      },
      {
        id: 'dismiss', title: 'Dismiss', resource: 'open_reports', action: 'op_dismiss_report', target: 'report_id',
        params: { report_id: 'report_id', from_status: 'status' }, confirm: 'Dismiss this report?',
        transition: { from: ['open', 'reviewing'], to: 'dismissed' },
      },
      ...(['approve', 'reject'] as const).map((verb) => ({
        id: `${verb}_kyc`, title: verb === 'approve' ? 'Approve' : 'Reject', resource: 'kyc', action: `op_${verb}_kyc`, target: 'request_id',
        params: { request_id: 'request_id', from_status: 'status' }, confirm: `${verb === 'approve' ? 'Approve' : 'Reject'} this identity check?`,
        transition: { from: ['pending'], to: verb === 'approve' ? 'approved' : 'rejected' },
      })),
      {
        id: 'lift', title: 'Lift', resource: 'suspension_history', action: 'op_lift_suspension', target: 'user_id',
        params: { suspension_id: 'suspension_id', from_status: 'status', user_id: 'user_id' }, confirm: 'Lift this suspension?',
        transition: { from: ['active'], to: 'lifted' },
      },
    ],
  },
};
