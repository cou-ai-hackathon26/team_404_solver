// Who may see which diagnostic report.
const db = require('../db');

/** Active (not expired, not revoked) grants a doctor holds for a patient. */
function activeGrants(doctorId, patientId) {
  return db.all(
    `SELECT * FROM access_grants
      WHERE doctor_id = ? AND patient_id = ? AND revoked = 0 AND expires_at > ?`,
    doctorId,
    patientId,
    new Date().toISOString()
  );
}

/** Reports a doctor can currently see for a patient. */
function reportsVisibleToDoctor(doctorId, patientId) {
  const grants = activeGrants(doctorId, patientId);
  if (!grants.length) return [];
  const all = grants.some((g) => g.report_id === null);
  const rows = db.all(
    `SELECT r.*, t.name AS test_name, c.name AS center_name
       FROM reports r JOIN test_catalog t ON t.id = r.test_id JOIN centers c ON c.id = r.center_id
      WHERE r.patient_id = ? ORDER BY r.test_date DESC`,
    patientId
  );
  if (all) return rows;
  const ids = new Set(grants.map((g) => g.report_id));
  return rows.filter((r) => ids.has(r.id));
}

/**
 * Can `user` open report `report`?
 * - patient: own reports
 * - center staff: only reports their own center uploaded
 * - doctor: only with an active grant (full or for this report)
 * - admin: no (admins manage accounts, not clinical data)
 */
function canViewReport(user, report) {
  if (!user || !report) return false;
  if (user.role === 'patient') return report.patient_id === user.id;
  if (user.role === 'center') return user.centerId === report.center_id;
  if (user.role === 'doctor') {
    return activeGrants(user.id, report.patient_id).some((g) => g.report_id === null || g.report_id === report.id);
  }
  return false;
}

module.exports = { activeGrants, reportsVisibleToDoctor, canViewReport };
