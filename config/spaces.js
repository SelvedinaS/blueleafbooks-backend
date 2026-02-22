const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// Support both SPACES_* and DO_SPACES_* env var names
const BUCKET = process.env.SPACES_BUCKET || process.env.DO_SPACES_BUCKET;
const region = process.env.SPACES_REGION || process.env.DO_SPACES_REGION || 'nyc3';
const endpoint = process.env.SPACES_ENDPOINT || process.env.DO_SPACES_ENDPOINT || `https://${region}.digitaloceanspaces.com`;
const accessKey = process.env.SPACES_KEY || process.env.DO_SPACES_KEY;
const secretKey = process.env.SPACES_SECRET || process.env.DO_SPACES_SECRET;

const s3Client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: false,
  credentials: {
    accessKeyId: accessKey,
    secretAccessKey: secretKey
  }
});

function isSpacesConfigured() {
  return !!(BUCKET && accessKey && secretKey);
}

/**
 * Get public URL for an object in Spaces
 * Use DO_SPACES_PUBLIC_BASE_URL or SPACES_PUBLIC_URL (e.g. https://bucket.fra1.digitaloceanspaces.com)
 */
function getPublicUrl(key) {
  const base = process.env.DO_SPACES_PUBLIC_BASE_URL || process.env.SPACES_PUBLIC_URL || process.env.DO_SPACES_PUBLIC_URL || `https://${BUCKET}.${region}.digitaloceanspaces.com`;
  return `${base.replace(/\/$/, '')}/${key.replace(/^\//, '')}`;
}

/**
 * Upload buffer to DigitalOcean Spaces and return public URL
 * @param {Buffer} buffer - file buffer
 * @param {string} key - object key (e.g. 'blueleafbooks/covers/xyz.jpg')
 * @param {string} contentType - MIME type (e.g. 'image/jpeg', 'application/pdf')
 */
async function uploadToSpaces(buffer, key, contentType) {
  await s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: 'public-read'
  }));
  return getPublicUrl(key);
}

module.exports = { s3Client, uploadToSpaces, getPublicUrl, BUCKET, isSpacesConfigured };
