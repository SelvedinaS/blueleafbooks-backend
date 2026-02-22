/**
 * Ensure coverImage and pdfFile are full URLs (relative -> absolute).
 * Used when returning book data to frontend.
 */
const BACKEND_BASE = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://blueleafbooks-backend-geum.onrender.com';

function toFullUrl(val) {
  if (!val || typeof val !== 'string') return val;
  if (/^https?:\/\//i.test(val)) return val;
  return `${BACKEND_BASE.replace(/\/$/, '')}/${val.replace(/^\/+/, '')}`;
}

function ensureFullUrls(book) {
  if (!book) return book;
  const b = book.toObject ? book.toObject() : { ...book };
  if (b.coverImage) b.coverImage = toFullUrl(b.coverImage);
  if (b.pdfFile) b.pdfFile = toFullUrl(b.pdfFile);
  return b;
}

function ensureFullUrlsMany(books) {
  return (books || []).map(b => ensureFullUrls(b));
}

module.exports = { ensureFullUrls, ensureFullUrlsMany };
