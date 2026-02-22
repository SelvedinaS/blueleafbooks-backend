/**
 * Ensure coverImage and pdfFile are full URLs (relative -> absolute).
 * Local paths -> /api/files/... . Spaces URLs -> /api/proxy-image?url=... (avoids CORS/referrer).
 */
const BACKEND_BASE = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://blueleafbooks-backend-geum.onrender.com';

function toFullUrl(val) {
  if (!val || typeof val !== 'string') return val;
  const base = BACKEND_BASE.replace(/\/$/, '');
  // Spaces URLs: proxy through backend to avoid CORS/referrer issues
  if (/^https?:\/\//i.test(val) && val.includes('digitaloceanspaces.com')) {
    return `${base}/api/proxy-image?url=${encodeURIComponent(val)}`;
  }
  if (/^https?:\/\//i.test(val)) return val;
  // Local uploads
  const coversMatch = val.match(/uploads\/covers\/(.+)$/);
  if (coversMatch) return `${base}/api/files/cover/${coversMatch[1]}`;
  const booksMatch = val.match(/uploads\/books\/(.+)$/);
  if (booksMatch) return `${base}/api/files/book/${booksMatch[1]}`;
  return `${base}/${val.replace(/^\/+/, '')}`;
}

function ensureFullUrls(book) {
  if (!book) return book;
  const b = book.toObject ? book.toObject() : { ...book };
  // Always ensure coverImage and pdfFile are full URLs (preserve if already full)
  if (b.coverImage != null && b.coverImage !== '') b.coverImage = toFullUrl(b.coverImage);
  if (b.pdfFile != null && b.pdfFile !== '') b.pdfFile = toFullUrl(b.pdfFile);
  return b;
}

function ensureFullUrlsMany(books) {
  return (books || []).map(b => ensureFullUrls(b));
}

module.exports = { ensureFullUrls, ensureFullUrlsMany };
