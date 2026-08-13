// Rotate the admin account's password. Works against whatever backend db.js is configured
// for (SQLite locally, Postgres on the VM), so run it once locally and once on the VM.
//
// Usage:
//   node execution/set_admin_password.js "<new-password>"
// or set it via env:
//   ADMIN_NEW_PASSWORD="<new-password>" node execution/set_admin_password.js
//
// The admin username defaults to "nickbuildsdecks" (override with ADMIN_USER).
const bcrypt = require('bcryptjs');
const db = require('../db');

(async () => {
  const newPassword = process.argv[2] || process.env.ADMIN_NEW_PASSWORD;
  if (!newPassword || newPassword.length < 8) {
    console.error('Provide a new password (>= 8 chars) as an argument or via ADMIN_NEW_PASSWORD.');
    process.exit(1);
  }
  const adminUser = process.env.ADMIN_USER || 'nickbuildsdecks';
  try {
    // No db.initDb() — the players table already exists, and running the full schema
    // init could trip over an older/drifted DB. We only need the open connection.
    const hash = bcrypt.hashSync(newPassword, 10);
    const res = await db.run('UPDATE players SET password_hash = ? WHERE username = ?', [hash, adminUser]);
    if (res && res.changes > 0) {
      console.log(`OK: password updated for admin user "${adminUser}".`);
    } else {
      console.log(`No account named "${adminUser}" found — nothing changed. (It will be created with the new password on next startup if ADMIN_PASSWORD is set.)`);
    }
    process.exit(0);
  } catch (e) {
    console.error('Failed to update admin password:', e.message);
    process.exit(1);
  }
})();
