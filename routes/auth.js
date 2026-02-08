const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate role
    if (role && !['customer', 'author'].includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Create user
    const user = new User({
      name,
      email,
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

// Forgot password - request reset (sends a secure reset link via email)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Always respond with success message to avoid leaking which emails exist
    if (!user) {
      return res.json({ message: 'If that email is registered, you will receive a password reset email shortly.' });
    }

    // Generate a secure random reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 1000 * 60 * 60; // 1 hour

    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(expires);
    await user.save();

    const baseUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:5500/frontend/pages';
    const resetLink = `${baseUrl}/reset-password.html?token=${encodeURIComponent(resetToken)}`;

    try {
      await sendEmail({
        to: user.email,
        subject: 'Reset your BlueLeafBooks password',
        html: `
          <h1>Password Reset Request</h1>
          <p>You (or someone else) requested a password reset for your BlueLeafBooks account.</p>
          <p>Click the link below to set a new password. This link is valid for 1 hour.</p>
          <p><a href="${resetLink}" target="_blank">Reset your password</a></p>
          <p>If you did not request this, you can safely ignore this email.</p>
        `
      });
    } catch (err) {
      console.error('Error sending reset email:', err);
      // Don't expose email sending issues to the user
    }

    res.json({ message: 'If that email is registered, you will receive a password reset email shortly.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Reset password - verify token and set new password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password, newPassword } = req.body;
    const finalPassword = newPassword || password;

    if (!token || !finalPassword) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    if (finalPassword.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters long' });
    }

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    user.password = finalPassword; // will be hashed by pre-save hook
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
