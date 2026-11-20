const db = require('../db');

/**
 * Record an action in the audit log.
 * Every view/download of a diagnostic report or medical record must call this.
 */
function audit(req, action, { entity = null, entityId = null, patientId = null, details = null, actor = null } = {}) {
  const user = actor || (req && req.user);
  db.run(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, patient_id, ip, details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    user ? user.id : null,
    user ? user.role : null,
    action,
    entity,
    entityId,
    patientId,
    req ? req.ip : null,
    details ? JSON.stringify(details) : null
  );
}

module.exports = { audit };
