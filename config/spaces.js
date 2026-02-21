const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const region = process.env.SPACES_REGION || 'nyc3';
const endpoint = `https://${region}.digitaloceanspaces.com`;

const s3Client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: false,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET
  }
});

const BUCKET = process.env.SPACES_BUCKET;

/**
 * Get public URL for an object in Spaces
 * Format: https://{bucket}.{region}.digitaloceanspaces.com/{key}
 * Or use SPACES_PUBLIC_URL if custom CDN/domain is configured
 */
function getPublicUrl(key) {
  const base = process.env.SPACES_PUBLIC_URL || `https://${BUCKET}.${region}.digitaloceanspaces.com`;
  return `${base.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
}

/**
 * Upload buffer to DigitalOcean Spaces and return public URL
 * @param {Buffer} buffer - file buffer
 * @param {string} key - object key (e.g. 'blueleafbooks/covers/xyz.jpg')
 * @param {string} contentType - MIME type (e.g. 'image/jpeg', 'application/pdf')
 */
async function uploadToSpaces(buffer, key, contentType) {
  // Note: Spaces ignores ACL on PutObject. Set bucket to "Public" or "File Listing" in DO dashboard.
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType
  }));
  return getPublicUrl(key);
}

module.exports = { s3Client, uploadToSpaces, getPublicUrl, BUCKET };
