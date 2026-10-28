import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import { authMiddleware } from '../middleware/auth.mjs';

// UPLOAD_DIR muss im Container auf das dauerhafte Volume zeigen (/data/uploads), sonst sind Dateien nach jedem Neubau weg
export const uploadDir = process.env.UPLOAD_DIR || join(process.env.HOME || homedir(), '.teamhafen', 'uploads');
mkdirSync(uploadDir, { recursive: true });

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, `${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

const router = Router();
router.use(authMiddleware);

// POST /api/uploads/image
router.post('/image', (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });
});

export default router;
