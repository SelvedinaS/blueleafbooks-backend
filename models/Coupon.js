const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true
  },
  discountPercentage: {
    type: Number,
    required: true,
    min: 1,
    max: 100
  },
  scope: {
    type: String,
    enum: ['author', 'all'],
    default: 'all'
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() {
      return this.scope === 'author';
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  validFrom: {
    type: Date
  },
  validTo: {
    type: Date
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Index for faster lookups (code already has unique index via unique: true)
couponSchema.index({ isActive: 1 });

module.exports = mongoose.model('Coupon', couponSchema);
