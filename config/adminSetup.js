const User = require('../models/User');
const bcrypt = require('bcryptjs');

/**
 * Ensures an admin user exists based on environment variables.
 * Creates admin user if it doesn't exist, or updates role if it does.
 */
const ensureAdminUser = async () => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    // Check if environment variables are set
    if (!adminEmail || !adminPassword) {
      console.warn('⚠️  ADMIN_EMAIL or ADMIN_PASSWORD not set in environment variables. Skipping admin user setup.');
      return;
    }

    // Check if admin user already exists
    const existingUser = await User.findOne({ email: adminEmail.toLowerCase().trim() });

    if (existingUser) {
      // User exists - ensure role is admin
      if (existingUser.role !== 'admin') {
        existingUser.role = 'admin';
        await existingUser.save();
        console.log(`✓ Admin user updated: ${adminEmail} (role set to admin)`);
      } else {
        console.log(`✓ Admin user already exists: ${adminEmail}`);
      }
    } else {
      // User doesn't exist - create new admin user
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      
      const adminUser = new User({
        name: 'Admin',
        email: adminEmail.toLowerCase().trim(),
        password: hashedPassword,
        role: 'admin'
      });

      await adminUser.save();
      console.log(`✓ Admin user created: ${adminEmail}`);
    }
  } catch (error) {
    console.error('❌ Error ensuring admin user:', error.message);
    // Don't exit process - allow server to start even if admin setup fails
  }
};

module.exports = ensureAdminUser;
