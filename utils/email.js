const nodemailer = require('nodemailer');

function createTransport() {
  // Use environment-based config; supports common local dev setups.
  // For example, configure:
  // EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: process.env.EMAIL_SECURE === 'true',
    auth: process.env.EMAIL_USER && process.env.EMAIL_PASS ? {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    } : undefined
  });
}

async function sendEmail({ to, subject, html }) {
  const transporter = createTransport();

  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'no-reply@blueleafbooks.com';

  await transporter.sendMail({
    from,
    to,
    subject,
    html
  });
}

module.exports = {
  sendEmail
};

