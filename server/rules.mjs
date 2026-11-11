// Business rules shared by the API: who may do what, and reserved-work priority.

export const ROLES = ['admin', 'manager', 'dispatcher', 'requester', 'rider'];
export const STAFF = ['admin', 'manager', 'dispatcher'];
/** Staff who may change things. Managers have read-only access to operations. */
export const WRITE_STAFF = ['admin', 'dispatcher'];
export const VEHICLES = ['petrol', 'electric'];
export const CATEGORIES = ['general', 'triangle', 'finance'];
export const RESERVED = ['triangle', 'finance'];
export const RIDER_TAGS = ['triangle', 'finance'];
export const HANDLING = ['fragile', 'keep_upright', 'confidential', 'signature', 'cash', 'documents', 'heavy'];
export const CATEGORY_LABEL = { general: 'General', triangle: 'Triangle', finance: 'Finance' };

export const isStaff = (user) => STAFF.includes(user.role);
export const canWrite = (user) => WRITE_STAFF.includes(user.role);

/**
 * Returns the list of priority-rule conflicts for assigning `request` to `rider`.
 * - Triangle / Finance work is reserved for riders designated with that tag.
 * - Designated riders are held back for their reserved work while such work waits unassigned.
 * `waitingReserved` maps category -> count of unassigned reserved requests (excluding this one).
 */
export function assignmentConflicts(request, rider, waitingReserved = {}) {
  const conflicts = [];
  const tags = rider.tags || [];
  if (RESERVED.includes(request.category) && !tags.includes(request.category)) {
    const label = CATEGORY_LABEL[request.category];
    conflicts.push({
      code: 'reserved_category',
      message: `${label} work is reserved for ${label}-designated riders, and ${rider.name} is not designated.`,
    });
  }
  for (const tag of tags) {
    if (request.category === tag) continue;
    const waiting = waitingReserved[tag] || 0;
    if (waiting > 0) {
      const label = CATEGORY_LABEL[tag];
      conflicts.push({
        code: 'reserved_rider',
        message: `${rider.name} is held for ${label} work and ${waiting} ${label} request${waiting === 1 ? ' is' : 's are'} still waiting.`,
      });
    }
  }
  return conflicts;
}

/** Sort key: urgent first, then reserved categories, then scheduled/created time. */
export function priorityRank(r) {
  const cat = r.category === 'triangle' ? 0 : r.category === 'finance' ? 1 : 2;
  return (r.priority === 'urgent' ? 0 : 10) + cat;
}
