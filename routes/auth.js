const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();


// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    const normalizedName = String(name || '').trim();
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPassword = String(password || '');

    if (!normalizedName) {
      return res.status(400).json({ message: 'Name is required' });
    }

    if (!normalizedEmail) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    if (normalizedPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    if (role && !['customer', 'author'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const user = new User({
      name: normalizedName,
      email: normalizedEmail,
      password: normalizedPassword,
      role: role || 'customer',
      isEmailVerified: true,
      emailVerificationToken: undefined,
      emailVerificationExpires: undefined
    });

    await user.save();

    res.status(201).json({
      message: 'Account created successfully. You can now log in.',
      email: user.email
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Verify email (disabled - email verification is not required)
router.get('/verify-email', async (req, res) => {
  return res.json({ success: true, message: 'Email verification is not required. You can log in directly.' });
});

// Resend verification email (disabled - email verification is not required)
router.post('/resend-verification', async (req, res) => {
  return res.json({ success: true, message: 'Email verification is not required.' });
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    // Find user
    const user = await User.findOne({ email: normalizedEmail });
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
