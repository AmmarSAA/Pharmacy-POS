// Permission-based access control, layered on top of the 3 fixed base roles (see auth.js ROLES).
// A handful of business rules still key off the base role directly (discount caps by role,
// cashiers barred from controlled drugs, cashiers seeing only their own sales/tills) — those stay
// as req.user.role checks, unchanged, in the routes that had them. Everything else (which screens
// and API routes a user may use) is gated by requirePermission, so an admin can build custom roles
// (e.g. "HR Manager") out of these same permission keys without touching that core business logic.
import { HttpError } from './http.js'

export const PERMISSIONS = [
  { key: 'sales.use', group: 'Sales', label: 'Sell at the till' },
  { key: 'sales.returns', group: 'Sales', label: 'Process returns & refunds' },
  { key: 'products.manage', group: 'Catalogue', label: 'Manage products (create, edit, import)' },
  { key: 'inventory.manage', group: 'Inventory', label: 'View stock movements & make adjustments' },
  { key: 'suppliers.manage', group: 'Purchasing', label: 'Manage suppliers' },
  { key: 'purchases.manage', group: 'Purchasing', label: 'Receive stock against supplier invoices' },
  { key: 'purchase_orders.manage', group: 'Purchasing', label: 'Create & send purchase orders' },
  { key: 'demand.manage', group: 'Purchasing', label: 'Manage demand / reorder lists' },
  { key: 'customers.manage', group: 'Customers', label: 'Manage customer accounts, credit & loyalty' },
  { key: 'transfers.manage', group: 'Inventory', label: 'Transfer stock between branches' },
  { key: 'issues.manage', group: 'Inventory', label: 'Issue stock to departments' },
  { key: 'tills.supervise', group: 'Tills', label: 'Day close & supervise tills' },
  { key: 'reports.view', group: 'Reports', label: 'View reports & BI dashboards' },
  { key: 'settings.manage', group: 'Administration', label: 'Edit pharmacy settings' },
  { key: 'hr.manage', group: 'People', label: 'Manage employee records' },
  { key: 'calendar.manage_all', group: 'Scheduling', label: "Manage everyone's appointments" },
  { key: 'knowledge.manage', group: 'Collaboration', label: 'Create & edit knowledge articles' },
  { key: 'users.manage', group: 'Administration', label: 'Manage users & roles' },
]
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key)

// Seeded once (see initDb in db.js) and never overwritten after that, so an admin's own edits to
// a system role's permissions survive a restart. base_role ties a role back to one of the 3 fixed
// roles for the handful of rules that are keyed off it directly rather than a permission.
export const SYSTEM_ROLES = [
  { key: 'cashier', name: 'Cashier', base_role: 'cashier', permissions: ['sales.use'] },
  {
    key: 'pharmacist', name: 'Pharmacist', base_role: 'pharmacist',
    permissions: [
      'sales.use', 'sales.returns', 'products.manage', 'inventory.manage', 'suppliers.manage',
      'purchases.manage', 'purchase_orders.manage', 'demand.manage', 'customers.manage',
      'transfers.manage', 'issues.manage', 'tills.supervise', 'reports.view',
      'calendar.manage_all', 'knowledge.manage',
    ],
  },
  { key: 'admin', name: 'Admin', base_role: 'admin', permissions: [...PERMISSION_KEYS] },
]

export const requirePermission = (...perms) => (req, res, next) => {
  const have = req.user?.permissions || []
  if (!perms.some((p) => have.includes(p))) {
    return next(new HttpError(403, 'You do not have permission to do this'))
  }
  next()
}
