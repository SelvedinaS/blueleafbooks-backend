const ensureAdminUser = require('./utils/ensureAdminUser');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/database');

// Connect to database
connectDB().then(async () => {
  await ensureAdminUser();
});

const app = express();

// IMPORTANT for Render (rate limit works correctly)
app.set('trust proxy', 1);

/* =========================
   CORS (SAFE for production)
========================= */
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ||
  'https://blueleafbooks.netlify.app';

const allowedOrigins = [
  FRONTEND_BASE_URL,
  'http://localhost:5173',
  'http://localhost:3000'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   RATE LIMITING
========================= */

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again later.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Please try again later.' }
});

const paypalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many payment requests. Please wait and try again.' }
});

const ordersLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many order requests. Please try again later.' }
});

// Apply general limiter to all API routes
app.use('/api', apiLimiter);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* =========================
   ROUTES
========================= */

app.use('/api/files', require('./routes/files'));
app.use('/api/media', require('./routes/proxyImage'));

app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/orders', ordersLimiter, require('./routes/orders'));
app.use('/api/paypal', paypalLimiter, require('./routes/paypal'));

app.use('/api/books', require('./routes/books'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/checkout', require('./routes/checkout'));
app.use('/api/authors', require('./routes/authors'));
app.use('/api/admin', require('./routes/admin'));

/* =========================
   HEALTH CHECK
========================= */

app.get('/api/health', (req, res) => {
  const { isSpacesConfigured } = require('./config/spaces');
  const backendBase =
    process.env.BACKEND_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://blueleafbooks-backend-geum.onrender.com';

  res.json({
    status: 'OK',
    message: 'BlueLeafBooks API is running',
    storage: isSpacesConfigured() ? 'spaces' : 'local',
    backendBase: backendBase.replace(/geun\./g, 'geum.')
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  const { isSpacesConfigured } = require('./config/spaces');
  const paypalMode = process.env.PAYPAL_MODE || 'sandbox';

  console.log(`Server running on port ${PORT}`);

  if (process.env.PAYPAL_CLIENT_ID) {
    console.log(`PayPal mode: ${paypalMode}`);
  }

  if (!isSpacesConfigured()) {
    console.warn('⚠️ DigitalOcean Spaces NOT configured.');
  }
});