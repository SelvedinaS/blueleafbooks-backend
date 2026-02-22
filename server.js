const ensureAdminUser = require('./utils/ensureAdminUser');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/database');


// Connect to database
connectDB().then(async () => {
  // Ensure admin user exists after database connection
  await ensureAdminUser();
});

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (legacy only - new uploads go to DigitalOcean Spaces)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/files', require('./routes/files'));
app.use('/api/proxy-image', require('./routes/proxyImage'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/books', require('./routes/books'));
app.use('/api/cart', require('./routes/cart'));
app.use('/api/checkout', require('./routes/checkout'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/paypal', require('./routes/paypal'));
app.use('/api/authors', require('./routes/authors'));
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  const { isSpacesConfigured } = require('./config/spaces');
  res.json({
    status: 'OK',
    message: 'BlueLeafBooks API is running',
    storage: isSpacesConfigured() ? 'spaces' : 'local'
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  const { isSpacesConfigured } = require('./config/spaces');
  console.log(`Server running on port ${PORT}`);
  if (!isSpacesConfigured()) {
    console.warn('⚠️  DigitalOcean Spaces NOT configured. Uploads use local disk and will be LOST on restart.');
    console.warn('   Set SPACES_BUCKET, SPACES_KEY, SPACES_SECRET in Render env vars for persistent images.');
  }
});
