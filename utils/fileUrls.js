/**
 * Ensure coverImage and pdfFile are full URLs (relative -> absolute).
 * Spaces URLs: return direct URL (img has referrerpolicy=no-referrer, avoids ad blocker).
 * Set USE_PROXY_FOR_IMAGES=true to use /api/media proxy instead.
 */
const BACKEND_BASE = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'https://blueleafbooks-backend-geum.onrender.com';
const USE_PROXY = process.env.USE_PROXY_FOR_IMAGES === 'true';

function toFullUrl(val) {
  if (!val || typeof val !== 'string') return val;
  // Fix common typos in stored URLs (fral→fra1, geun→geum)
  let fixed = val.replace(/\.fral\./g, '.fra1.').replace(/geun\./g, 'geum.');
  const base = BACKEND_BASE.replace(/\/$/, '').replace(/geun\./g, 'geum.');
  // Spaces URLs: direct (avoids ad blocker) or proxy if USE_PROXY_FOR_IMAGES=true
  if (/^https?:\/\//i.test(fixed) && fixed.includes('digitaloceanspaces.com')) {
    return USE_PROXY ? `${base}/api/media?url=${encodeURIComponent(fixed)}` : fixed;
  }
  if (/^https?:\/\//i.test(fixed)) return fixed;
  // Local uploads
  const coversMatch = fixed.match(/uploads\/covers\/(.+)$/);
  if (coversMatch) return `${base}/api/files/cover/${coversMatch[1]}`;
  const booksMatch = fixed.match(/uploads\/books\/(.+)$/);
  if (booksMatch) return `${base}/api/files/book/${booksMatch[1]}`;
  return `${base}/${fixed.replace(/^\/+/, '')}`;
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
