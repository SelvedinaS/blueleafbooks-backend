const mongoose = require('mongoose');

const platformFeeStatusSchema = new mongoose.Schema({
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  period: {
    // YYYY-MM (e.g., 2026-02)
    type: String,
    required: true,
    index: true
  },
  isPaid: {
    type: Boolean,
    default: false
  },
  paidAt: {
    type: Date
  },
  note: {
    type: String,
    trim: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Unique per author+period
platformFeeStatusSchema.index({ author: 1, period: 1 }, { unique: true });

module.exports = mongoose.model('PlatformFeeStatus', platformFeeStatusSchema);
