const nodemailer = require('nodemailer');

function createTransport() {
  // EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
  // For Hotmail/Outlook: smtp-mail.outlook.com, port 587
  // Microsoft may require App Password: https://account.microsoft.com/security
  const hasAuth = process.env.EMAIL_USER && process.env.EMAIL_PASS;
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp-mail.outlook.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: false,
    auth: hasAuth ? {
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

