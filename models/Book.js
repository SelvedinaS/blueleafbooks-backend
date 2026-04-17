const mongoose = require('mongoose');
const { BOOK_GENRES } = require('../config/bookGenres');

const bookSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  genre: {
    type: String,
    required: true,
    trim: true,
    enum: BOOK_GENRES
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  productType: {
    type: String,
    enum: ['book', 'planner'],
    default: 'book'
  },
  coverImage: {
    type: String,
    required: true
  },
  pdfFile: {
    type: String,
    required: true
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  ratingCount: {
    type: Number,
    default: 0
  },
  ratings: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    value: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    createdAt: {
      type: Date,
      default: Date.now
    },
    updatedAt: {
      type: Date,
      default: Date.now
    }
  }],
  salesCount: {
    type: Number,
    default: 0
  },
  isDeleted: {
    type: Boolean,
    default: false
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  featuredOrder: {
    type: Number,
    default: 0,
    min: 0
  },
  isDemo: {
    type: Boolean,
    default: false
  },

  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    // Books should be visible immediately, so default to approved
    default: 'approved'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

bookSchema.index({ title: 'text', description: 'text' });
bookSchema.index({ genre: 1 });
bookSchema.index({ status: 1 });
bookSchema.index({ isDeleted: 1 });
bookSchema.index({ isDemo: 1 });

module.exports = mongoose.model('Book', bookSchema);
