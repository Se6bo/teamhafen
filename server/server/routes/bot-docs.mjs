import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.mjs';
import { uploadDir } from './uploads.mjs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { normalizeContent } from '../docs/content.mjs';

const router = Router();
// Schnittstelle für Bots (z. B. einen Discord Bot), die Doku lesen und schreiben.
// Nur aktiv, wenn BOT_TOKEN gesetzt ist; der Bot schickt "Authorization: Bearer <BOT_TOKEN>".
function botAuth(req, res, next) {
  const expected = process.env.BOT_TOKEN || '';
  if (expected.length < 16) return res.status(404).json({ error: 'Nicht gefunden' });
  const header = req.headers.authorization || '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7).trim() : '');
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ error: 'Ungültiger Bot Token' });
  next();
}
router.use(botAuth);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req,file,cb)=>cb(null,uploadDir),
    filename: (req,file,cb)=>cb(null,randomUUID()+extname(file.originalname).toLowerCase())
  }),
  limits:{fileSize:10*1024*1024}
});

router.get('/folders',(req,res)=>{
  const db=getDb();
  res.json(db.prepare(`SELECT f.*, COUNT(d.id) AS doc_count FROM doc_folders f LEFT JOIN documentation d ON d.folder_id=f.id GROUP BY f.id ORDER BY f.name ASC`).all());
});
router.post('/folders',(req,res)=>{
  const db=getDb(),name=String(req.body?.name||'').trim();
  if(!name)return res.status(400).json({error:'Name is required'});
  const systemUser=db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  const r=db.prepare('INSERT INTO doc_folders (name,created_by) VALUES (?,?)').run(name,systemUser?.id||null);
  res.status(201).json(db.prepare('SELECT *,0 AS doc_count FROM doc_folders WHERE id=?').get(r.lastInsertRowid));
});

router.get('/',(req,res)=>{
  const db=getDb();
  res.json(db.prepare('SELECT d.*, f.name as folder_name FROM documentation d LEFT JOIN doc_folders f ON d.folder_id=f.id ORDER BY d.updated_at DESC').all());
});
router.get('/:id',(req,res)=>{
  const db=getDb();
  const doc=db.prepare('SELECT d.*, f.name as folder_name FROM documentation d LEFT JOIN doc_folders f ON d.folder_id=f.id WHERE d.id=?').get(req.params.id);
  if(!doc)return res.status(404).json({error:'Document not found'});
  res.json(doc);
});
router.post('/',(req,res)=>{
  const db=getDb(),{title,category='project',folder_id=null}=req.body;
  // Wie im Portal: HTML säubern, reinen Text als Markdown umwandeln
  const content=normalizeContent(req.body.content??'');
  if(!title?.trim())return res.status(400).json({error:'Title is required'});
  const systemUser=db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if(!systemUser)return res.status(500).json({error:'No user available'});
  const r=db.prepare('INSERT INTO documentation (title,content,category,author_id,folder_id) VALUES (?,?,?,?,?)').run(title.trim(),content,category,systemUser.id,folder_id||null);
  if(content)db.prepare('INSERT INTO doc_versions (doc_id,content,version_number,created_by) VALUES (?,?,1,?)').run(r.lastInsertRowid,content,systemUser.id);
  res.status(201).json(db.prepare('SELECT * FROM documentation WHERE id=?').get(r.lastInsertRowid));
});
router.put('/:id',(req,res)=>{
  const db=getDb(),doc=db.prepare('SELECT * FROM documentation WHERE id=?').get(req.params.id);
  if(!doc)return res.status(404).json({error:'Document not found'});
  const {title,category,folder_id}=req.body;
  const content=req.body.content==null?undefined:normalizeContent(req.body.content);
  const user=db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if(content!==undefined && content!==doc.content){
    const v=db.prepare('SELECT MAX(version_number) max_version FROM doc_versions WHERE doc_id=?').get(req.params.id);
    db.prepare('INSERT INTO doc_versions (doc_id,content,version_number,created_by) VALUES (?,?,?,?)').run(req.params.id,doc.content||'',(v?.max_version||0)+1,user?.id);
  }
  const hasFolder = Object.prototype.hasOwnProperty.call(req.body, 'folder_id');
  if (hasFolder) {
    db.prepare('UPDATE documentation SET title=COALESCE(?,title),content=COALESCE(?,content),category=COALESCE(?,category),folder_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title??null,content??null,category??null,folder_id??null,req.params.id);
  } else {
    db.prepare('UPDATE documentation SET title=COALESCE(?,title),content=COALESCE(?,content),category=COALESCE(?,category),updated_at=CURRENT_TIMESTAMP WHERE id=?').run(title??null,content??null,category??null,req.params.id);
  }
  res.json(db.prepare('SELECT * FROM documentation WHERE id=?').get(req.params.id));
});
router.post('/:id/upload',upload.single('file'),(req,res)=>{
  const db=getDb();
  if(!db.prepare('SELECT id FROM documentation WHERE id=?').get(req.params.id))return res.status(404).json({error:'Document not found'});
  if(!req.file)return res.status(400).json({error:'No file provided'});
  const r=db.prepare('INSERT INTO doc_files (doc_id,filename,original_name,mimetype,size) VALUES (?,?,?,?,?)').run(req.params.id,req.file.filename,req.file.originalname,req.file.mimetype,req.file.size);
  res.status(201).json(db.prepare('SELECT * FROM doc_files WHERE id=?').get(r.lastInsertRowid));
});
router.get('/:id/files',(req,res)=>{
  const db=getDb();
  res.json(db.prepare('SELECT * FROM doc_files WHERE doc_id=? ORDER BY uploaded_at DESC').all(req.params.id));
});
export default router;
