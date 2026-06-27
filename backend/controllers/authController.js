const userQ = require("../db/queries/userQueries");
const { pool } = require("../db/pool");

async function login(req, res) {
  const { employeeId, password } = req.body || {};
  if (!employeeId || !password)
    return res.status(400).json({ success: false, message: "Employee ID and password required" });

  const user = await userQ.findByCredentials(employeeId, password);
  if (!user) return res.status(401).json({ success: false, message: "Invalid Employee ID or Password" });

  const { rows: sglRows } = await pool.query(
    `SELECT 1 FROM project_sgls WHERE user_id = $1 LIMIT 1`, [user.id]
  );
  const isSgl = sglRows.length > 0;

  const { rows: roleRows } = await pool.query(
    `SELECT DISTINCT role FROM user_role_assignments WHERE user_id = $1`,
    [user.id]
  );
  const roles = roleRows.map(r => r.role);
  if (isSgl && !roles.includes('SGL')) roles.push('SGL');

  req.session.user = { id: user.id, name: user.name, isHod: user.is_hod, isSgl, roles };

  let redirect = "/user.html";
  if (user.is_hod) redirect = "/hod.html";
  else if (isSgl && roles.length === 1) redirect = "/sgl.html";

  res.json({ success: true, redirect });
}

function logout(req, res) {
  req.session.destroy(() => res.json({ success: true }));
}

function me(req, res) {
  res.json(req.session.user);
}

async function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const userId = req.session.user?.id;

  if (!currentPassword || !newPassword)
    return res.status(400).json({ message: 'Current and new password are required.' });

  if (newPassword.length < 6)
    return res.status(400).json({ message: 'New password must be at least 6 characters.' });

  const { rows } = await pool.query(
    'SELECT id FROM users WHERE id = $1 AND password = $2',
    [userId, currentPassword]
  );
  if (!rows.length)
    return res.status(401).json({ message: 'Current password is incorrect.' });

  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [newPassword, userId]);

  req.session.destroy(() => {
    res.json({ ok: true, message: 'Password changed successfully.' });
  });
}

module.exports = { login, logout, me, changePassword };
