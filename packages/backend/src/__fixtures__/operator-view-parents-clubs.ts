/** Parents Clubs, the second sample app declaring the operator-view contract (#240). */
const operator = (reason: string) => ({ app_roles: ['operator'], caller_unscoped: { reason } });

/**
 * Parents Clubs, shaped differently: parents (users), flagged posts (reports)
 * with a new → upheld/rejected workflow, suspensions per parent, an
 * ID-verification queue (licence evidence, approve/decline), club KPIs.
 */
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
      name: 'op_list_flags', description: 'Flagged posts', operation: 'query', requires_auth: true,
      params: { state: { type: 'string', optional: true }, cursor: { type: 'string', optional: true } },
      sql: 'SELECT f.flag_id, f.post_title, f.flagged_by, f.state, f.flagged_at FROM flags f WHERE (:state IS NULL OR f.state = :state) AND (:cursor IS NULL OR f.flag_id > :cursor) ORDER BY f.flag_id LIMIT 30',
      auth: operator('Operators see every flag.'),
    },
    ...(['uphold', 'reject'] as const).map((verb) => ({
      name: `op_${verb}_flag`, description: `${verb} a flag`, operation: 'execute', requires_auth: true,
      params: { flag: { type: 'string' }, was: { type: 'string' } },
      sql: `UPDATE flags SET state = '${verb === 'uphold' ? 'upheld' : 'rejected'}', decided_by = :__user_id WHERE flag_id = :flag AND state = :was`,
      auth: { app_roles: ['moderator', 'operator'] },
    })),
    {
      name: 'op_pending_verifications', description: 'ID checks', operation: 'query', requires_auth: true,
      params: { state: { type: 'string', optional: true } },
      sql: 'SELECT v.id AS request_id, v.parent_name, v.state, v.submitted_at FROM verification_requests v WHERE (:state IS NULL OR v.state = :state) ORDER BY v.submitted_at LIMIT 100',
      auth: operator('Operators review every ID check.'),
    },
    {
      name: 'op_verification_detail', description: 'One ID check', operation: 'query', requires_auth: true, step_up: true,
      params: { id: { type: 'string' } },
      sql: 'SELECT v.id AS request_id, v.parent_name, v.state, v.submitted_at, v.licence_path FROM verification_requests v WHERE v.id = :id LIMIT 1',
      auth: operator('Operators open any ID check.'),
    },
    ...(['approve', 'decline'] as const).map((verb) => ({
      name: `op_${verb}_verification`, description: `${verb} an ID check`, operation: 'execute', requires_auth: true, step_up: true,
      params: { request_id: { type: 'string' }, was: { type: 'string' } },
      sql: `UPDATE verification_requests SET state = '${verb === 'approve' ? 'approved' : 'declined'}', reviewed_by = :__user_id WHERE id = :request_id AND state = :was`,
      auth: { app_roles: ['operator'] },
    })),
    {
      name: 'op_list_suspensions', description: 'Suspended parents', operation: 'query', requires_auth: true,
      params: { parent: { type: 'string', optional: true } },
      sql: 'SELECT s.user_id, s.reason, s.until, s.state FROM suspensions s WHERE (:parent IS NULL OR s.user_id = :parent) ORDER BY s.until DESC LIMIT 100',
      auth: operator('Operators see every suspension.'),
    },
    {
      name: 'op_suspend_parent', description: 'Suspend a parent for a week', operation: 'execute', requires_auth: true, step_up: true,
      params: { id: { type: 'string' } },
      sql: "INSERT INTO suspensions (user_id, reason, until, state, created_by) VALUES (:id, 'operator', :__now + 604800000, 'active', :__user_id)",
      auth: { app_roles: ['operator'] },
    },
    {
      name: 'op_end_suspension', description: 'End a suspension', operation: 'execute', requires_auth: true,
      params: { parent: { type: 'string' }, state: { type: 'string' } },
      sql: "UPDATE suspensions SET state = 'ended' WHERE user_id = :parent AND state = :state",
      auth: operator('Operators end any suspension.'),
    },
    {
      name: 'op_weekly_clubs', description: 'Weekly club activity', operation: 'query', requires_auth: true,
      params: { since: { type: 'string', optional: true }, until: { type: 'string', optional: true } },
      sql: 'SELECT w.week_start, w.attendance_rate, w.events, w.fees FROM weekly_club_stats w WHERE w.week_start >= :since AND w.week_start <= :until ORDER BY w.week_start LIMIT 200',
      auth: operator('App-wide weekly club activity.'),
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
        id: 'flags', kind: 'reports', title: 'Flagged posts', action: 'op_list_flags',
        columns: [
          { key: 'post_title', label: 'Post' },
          { key: 'flagged_by', label: 'Flagged by' },
          { key: 'state', label: 'State', format: 'badge' },
          { key: 'flagged_at', label: 'Flagged', format: 'datetime' },
          { key: 'flag_id', label: 'Flag' },
        ],
        page: { param: 'cursor', column: 'flag_id' },
        status: {
          column: 'state', param: 'state',
          states: [{ value: 'new', label: 'New' }, { value: 'upheld', label: 'Upheld' }, { value: 'rejected', label: 'Rejected' }],
        },
      },
      {
        id: 'id_checks', kind: 'verification', title: 'ID checks', action: 'op_pending_verifications',
        columns: [
          { key: 'parent_name', label: 'Parent' },
          { key: 'state', label: 'State', format: 'badge' },
          { key: 'submitted_at', label: 'Submitted', format: 'datetime' },
          { key: 'request_id', label: 'Request' },
        ],
        status: {
          column: 'state', param: 'state',
          states: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'declined', label: 'Declined' }],
        },
        detail: {
          action: 'op_verification_detail', param: 'id', key: 'request_id',
          fields: [
            { key: 'parent_name', label: 'Parent' },
            { key: 'state', label: 'State', format: 'badge' },
            { key: 'submitted_at', label: 'Submitted', format: 'datetime' },
            { key: 'request_id', label: 'Request' },
            { key: 'licence_path', label: "Driver's licence" },
          ],
          evidence: [{ field: 'licence_path', label: "Driver's licence" }],
        },
      },
      {
        id: 'suspended', kind: 'suspensions', title: 'Suspended parents', action: 'op_list_suspensions',
        columns: [
          { key: 'user_id', label: 'User' },
          { key: 'reason', label: 'Reason' },
          { key: 'until', label: 'Until', format: 'datetime' },
          { key: 'state', label: 'State', format: 'badge' },
        ],
        related: { resource: 'parents', param: 'parent' },
        status: { column: 'state', states: [{ value: 'active', label: 'Active' }, { value: 'ended', label: 'Ended' }] },
      },
      {
        id: 'clubs', kind: 'metrics', title: 'Clubs', action: 'op_club_metrics',
        columns: [
          { key: 'clubs', label: 'Clubs', format: 'number' },
          { key: 'members', label: 'Members', format: 'number' },
        ],
      },
      {
        id: 'club_trends', kind: 'metrics', title: 'Club trends', action: 'op_weekly_clubs',
        columns: [
          { key: 'week_start', label: 'Week', format: 'datetime' },
          { key: 'attendance_rate', label: 'Attendance', format: 'number' },
          { key: 'events', label: 'Events', format: 'number' },
          { key: 'fees', label: 'Fees', format: 'number' },
        ],
        series: {
          time: { column: 'week_start', grain: 'week' },
          range: { from_param: 'since', to_param: 'until', default_days: 84, max_days: 366 },
          measures: [
            { column: 'attendance_rate', label: 'Attendance', unit: 'percent', aggregation: 'avg' },
            { column: 'events', label: 'Events', unit: 'count', aggregation: 'sum' },
            { column: 'fees', label: 'Fees collected', unit: 'currency', currency: 'GBP', aggregation: 'sum' },
          ],
        },
      },
    ],
    actions: [
      ...(['approve', 'decline'] as const).map((verb) => ({
        id: verb, title: verb === 'approve' ? 'Approve' : 'Decline', resource: 'id_checks', action: `op_${verb}_verification`, target: 'request_id',
        params: { request_id: 'request_id', was: 'state' }, confirm: `${verb === 'approve' ? 'Approve' : 'Decline'} this ID check?`,
        transition: { from: ['pending'], to: verb === 'approve' ? 'approved' : 'declined' },
      })),
      {
        id: 'uphold', title: 'Uphold', resource: 'flags', action: 'op_uphold_flag', target: 'flag_id',
        params: { flag: 'flag_id', was: 'state' }, confirm: 'Uphold this flag?', transition: { from: ['new'], to: 'upheld' },
      },
      {
        id: 'reject', title: 'Reject', resource: 'flags', action: 'op_reject_flag', target: 'flag_id',
        params: { flag: 'flag_id', was: 'state' }, confirm: 'Reject this flag?', transition: { from: ['new'], to: 'rejected' },
      },
      { id: 'suspend', title: 'Suspend', resource: 'parents', action: 'op_suspend_parent', params: { id: 'user_id' }, confirm: 'Suspend this parent for a week?', destructive: true },
      {
        id: 'end_suspension', title: 'End', resource: 'suspended', action: 'op_end_suspension', target: 'user_id',
        params: { parent: 'user_id', state: 'state' }, confirm: 'End this suspension?', transition: { from: ['active'], to: 'ended' },
      },
    ],
    // The trail of who looked at which parent is itself sensitive: owners need the operator role to read it.
    audit: { app_roles: ['operator'] },
  },
};
