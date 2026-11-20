// File uploads are stored OUTSIDE /public and served only through
// authorized, audited routes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');

const ALLOWED = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function uploader(subdir) {
  const dir = path.join(config.uploadDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().slice(0, 8);
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (ALLOWED.has(file.mimetype)) cb(null, true);
      else cb(new Error('Only PDF, JPG, PNG or WEBP files up to 10 MB are allowed.'));
    },
  });
}

/** Wrap a multer middleware so upload errors become a flash message instead of a crash. */
function handleUpload(mw, redirectTo) {
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (err) {
        req.flash('error', err.message);
        return res.redirect(typeof redirectTo === 'function' ? redirectTo(req) : redirectTo);
      }
      next();
    });
}

module.exports = { uploader, handleUpload, relative: (abs) => path.relative(config.uploadDir, abs) };
