/**
 * Ensure coverImage and pdfFile are full URLs (relative -> absolute).
 * Local paths like uploads/covers/xxx.jpg -> /api/files/cover/xxx.jpg (more reliable on Render).
 */
const BACKEND_BASE = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://blueleafbooks-backend-geum.onrender.com';

function toFullUrl(val) {
  if (!val || typeof val !== 'string') return val;
  if (/^https?:\/\//i.test(val)) return val;
  const base = BACKEND_BASE.replace(/\/$/, '');
  // Route local uploads through /api/files for better compatibility
  const coversMatch = val.match(/uploads\/covers\/(.+)$/);
  if (coversMatch) return `${base}/api/files/cover/${coversMatch[1]}`;
  const booksMatch = val.match(/uploads\/books\/(.+)$/);
  if (booksMatch) return `${base}/api/files/book/${booksMatch[1]}`;
  return `${base}/${val.replace(/^\/+/, '')}`;
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
