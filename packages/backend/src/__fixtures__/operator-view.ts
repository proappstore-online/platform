/**
 * Two sample apps declaring the operator-view contract (#240): the backend
 * unit and workerd tests register both through the same generic path, to
 * prove a second app needs no bespoke platform or console code.
 */
const operator = (reason: string) => ({ app_roles: ['operator'], caller_unscoped: { reason } });

/** Stash: cross-pocket users, problem reports, suspensions from a report, KPIs. */
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
      name: 'op_list_reports', description: 'Problem reports by status', operation: 'query', requires_auth: true,
      params: { status: { type: 'string', default: 'open' } },
      sql: 'SELECT r.id AS report_id, r.reported_user_id, r.reason, r.status, r.created_at FROM reports r WHERE r.status = :status ORDER BY r.created_at DESC LIMIT 200',
      auth: operator('Operators triage every report.'),
    },
    {
      name: 'op_report_metrics', description: 'Moderation KPIs', operation: 'query', requires_auth: true, params: {},
      sql: "SELECT COUNT(*) AS open_reports, (SELECT COUNT(*) FROM members WHERE suspended = 1) AS suspended_users FROM reports WHERE status = 'open'",
      auth: operator('App-wide moderation counts.'),
    },
    {
      name: 'op_suspend_user', description: 'Suspend a member', operation: 'execute', requires_auth: true,
      params: { user_id: { type: 'string' } },
      sql: 'UPDATE members SET suspended = 1 WHERE id = :user_id',
      auth: operator('Operators suspend any member.'),
    },
    {
      name: 'op_resolve_report', description: 'Resolve a report', operation: 'execute', requires_auth: true,
      params: { report_id: { type: 'string' } },
      sql: "UPDATE reports SET status = 'resolved' WHERE id = :report_id",
      auth: operator('Operators resolve any report.'),
    },
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
        id: 'open_reports', kind: 'reports', title: 'Open reports', description: 'Reports waiting for review.', action: 'op_list_reports',
        columns: [
          { key: 'reason', label: 'Reason' },
          { key: 'reported_user_id', label: 'Reported user' },
          { key: 'status', label: 'Status', format: 'badge' },
          { key: 'created_at', label: 'Filed', format: 'datetime' },
          { key: 'report_id', label: 'Report' },
        ],
      },
      {
        id: 'moderation', kind: 'metrics', title: 'Moderation', action: 'op_report_metrics',
        columns: [
          { key: 'open_reports', label: 'Open reports', format: 'number' },
          { key: 'suspended_users', label: 'Suspended', format: 'number' },
        ],
      },
    ],
    actions: [
      { id: 'suspend_member', title: 'Suspend', resource: 'members', action: 'op_suspend_user', params: { user_id: 'user_id' }, confirm: 'Suspend this member?' },
      { id: 'suspend_reported', title: 'Suspend user', resource: 'open_reports', action: 'op_suspend_user', params: { user_id: 'reported_user_id' }, confirm: 'Suspend the reported user?' },
      { id: 'resolve', title: 'Resolve', resource: 'open_reports', action: 'op_resolve_report', params: { report_id: 'report_id' }, confirm: 'Mark this report resolved?' },
    ],
  },
};

/** Parents Clubs: parents (users, differently shaped), an ID-verification queue with a step-up approval, suspensions, club KPIs. */
export const PARENTS_CLUBS = {
  tools: [
    {
      name: 'op_list_parents', description: 'Parents across clubs', operation: 'query', requires_auth: true,
      params: { search: { type: 'string', optional: true }, cursor: { type: 'string', optional: true } },
      sql: "SELECT p.user_id, p.full_name, p.club_name, p.verified FROM parents p WHERE (:search IS NULL OR p.full_name LIKE '%' || :search || '%') AND (:cursor IS NULL OR p.user_id > :cursor) ORDER BY p.user_id LIMIT 25",
      auth: operator('Operators see parents across clubs.'),
    },
    {
      name: 'op_parent_detail', description: 'One parent', operation: 'query', requires_auth: true,
      params: { id: { type: 'string' } },
      sql: 'SELECT p.user_id, p.full_name, p.phone, p.club_name, p.joined_at FROM parents p WHERE p.user_id = :id LIMIT 1',
      auth: operator('Operators open any parent.'),
    },
    {
      name: 'op_pending_verifications', description: 'Pending ID checks', operation: 'query', requires_auth: true, params: {},
      sql: "SELECT v.id AS request_id, v.parent_name, v.submitted_at FROM verification_requests v WHERE v.state = 'pending' ORDER BY v.submitted_at LIMIT 100",
      auth: operator('Operators review every pending check.'),
    },
    {
      name: 'op_approve_verification', description: 'Approve an ID check', operation: 'execute', requires_auth: true, step_up: true,
      params: { request_id: { type: 'string' } },
      sql: "UPDATE verification_requests SET state = 'approved', reviewed_by = :__user_id WHERE id = :request_id",
      auth: { app_roles: ['operator'] },
    },
    {
      name: 'op_list_suspensions', description: 'Suspended parents', operation: 'query', requires_auth: true, params: {},
      sql: 'SELECT s.user_id, s.reason, s.until FROM suspensions s ORDER BY s.until DESC LIMIT 100',
      auth: operator('Operators see every suspension.'),
    },
    {
      name: 'op_club_metrics', description: 'Club KPIs', operation: 'query', requires_auth: true, params: {},
      sql: 'SELECT COUNT(*) AS clubs, SUM(member_count) AS members FROM clubs',
      auth: operator('App-wide club counts.'),
    },
  ],
  operator_view: {
    version: 1,
    resources: [
      {
        id: 'parents', kind: 'users', title: 'Parents', action: 'op_list_parents',
        columns: [
          { key: 'full_name', label: 'Parent' },
          { key: 'club_name', label: 'Club' },
          { key: 'verified', label: 'Verified', format: 'boolean' },
          { key: 'user_id', label: 'User' },
        ],
        search: { param: 'search' },
        page: { param: 'cursor', column: 'user_id' },
        detail: {
          action: 'op_parent_detail', param: 'id', key: 'user_id',
          fields: [
            { key: 'full_name', label: 'Parent' },
            { key: 'club_name', label: 'Club' },
            { key: 'joined_at', label: 'Joined', format: 'datetime' },
          ],
        },
      },
      {
        id: 'id_checks', kind: 'verification', title: 'ID checks', action: 'op_pending_verifications',
        columns: [
          { key: 'parent_name', label: 'Parent' },
          { key: 'submitted_at', label: 'Submitted', format: 'datetime' },
          { key: 'request_id', label: 'Request' },
        ],
      },
      {
        id: 'suspended', kind: 'suspensions', title: 'Suspended parents', action: 'op_list_suspensions',
        columns: [
          { key: 'user_id', label: 'User' },
          { key: 'reason', label: 'Reason' },
          { key: 'until', label: 'Until', format: 'datetime' },
        ],
      },
      {
        id: 'clubs', kind: 'metrics', title: 'Clubs', action: 'op_club_metrics',
        columns: [
          { key: 'clubs', label: 'Clubs', format: 'number' },
          { key: 'members', label: 'Members', format: 'number' },
        ],
      },
    ],
    actions: [
      { id: 'approve', title: 'Approve', resource: 'id_checks', action: 'op_approve_verification', params: { request_id: 'request_id' }, confirm: 'Approve this ID check?' },
    ],
  },
};
