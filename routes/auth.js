const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dns = require('dns').promises;
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    // Validate role
    if (role && !['customer', 'author'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Basic MX check to see if email domain exists
    const parts = normalizedEmail.split('@');
    if (parts.length !== 2 || !parts[1]) {
      return res.status(400).json({ message: 'Invalid email address' });
    }
    const domain = parts[1];
    try {
      const mxRecords = await dns.resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        return res.status(400).json({ message: 'Email domain does not accept mail' });
      }
    } catch (err) {
      return res.status(400).json({ message: 'Email domain does not exist or cannot be reached' });
    }

    // Create user
    const user = new User({
      name,
      email: normalizedEmail,
      password,
      role: role || 'customer'
    });

    await user.save();

    // Send welcome email for authors
    if (user.role === 'author') {
      try {
        await sendEmail({
          to: user.email,
          subject: 'Welcome to BlueLeafBooks',
          html: `
            <h1>Welcome to BlueLeafBooks, ${user.name}!</h1>
            <p>Your author account has been created successfully.</p>
            <p>You can now log in, upload your books, and track your earnings in the author dashboard.</p>
          `
        });
      } catch (err) {
        console.error('Error sending welcome email:', err);
        // Do not fail registration if email sending fails
      }
    }

    // Generate token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate token
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role
      }
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  res.json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role
    }
  });
});

// Forgot password - manual support flow (no automatic email sending)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Clear any stale reset tokens so old links cannot be reused later.
    if (user) {
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();
    }

    return res.json({
      message: 'Password reset is handled manually. Please contact BlueLeafBooks support at blueleafbooks@hotmail.com and include your account email address.'
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reset password - manual support flow only
router.post('/reset-password', async (req, res) => {
  return res.status(400).json({
    message: 'Automatic reset links are not currently in use. Please contact BlueLeafBooks support at blueleafbooks@hotmail.com for manual password reset support.'
  });
});

module.exports = router;
