const User = require('../models/User');

/**
 * Ensures an admin user exists based on environment variables.
 * Creates admin user if it doesn't exist, or updates role and password if it does.
 * Uses the same password hashing logic as user registration (User model's pre('save') hook).
 */
async function ensureAdminUser() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.log('Admin email or password missing in .env. Skipping admin setup.');
    return;
  }

  try {
    const normalizedEmail = adminEmail.toLowerCase().trim();
    let admin = await User.findOne({ email: normalizedEmail });

    if (!admin) {
      // User doesn't exist - create new admin user
      // Set password as plain text - User model's pre('save') hook will hash it
      // (same logic as user registration)
      admin = new User({
        name: "BlueLeaf Admin",
        email: normalizedEmail,
        password: adminPassword, // Plain text - will be hashed by pre('save') hook
        role: "admin"
      });

      await admin.save();
      console.log(`✓ Admin user created: ${adminEmail}`);
    } else {
      // User exists - ensure role is admin and update password
      let needsSave = false;
      
      if (admin.role !== 'admin') {
        admin.role = "admin";
        needsSave = true;
      }
      
      // Always update password to match ADMIN_PASSWORD from .env
      // Set as plain text - User model's pre('save') hook will hash it
      // (same logic as user registration)
      admin.password = adminPassword; // Plain text - will be hashed by pre('save') hook
      needsSave = true;
      
      if (needsSave) {
        await admin.save();
        console.log(`✓ Admin user updated: ${adminEmail} (role and password updated)`);
      } else {
        console.log(`✓ Admin user already exists: ${adminEmail}`);
      }
    }
  } catch (err) {
    console.error("❌ Error ensuring admin user:", err.message);
    // Don't exit process - allow server to start even if admin setup fails
  }
}

module.exports = ensureAdminUser;
