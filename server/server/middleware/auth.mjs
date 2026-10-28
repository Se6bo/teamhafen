import { verifyToken } from '../auth/jwt.mjs';

// Anmeldungen, die der MCP Server intern für die KI ausstellt, gelten nur für Doku und Sprints.
// Tresor, Benutzer, Passkeys, Suche (enthält Tresor Einträge) und die KI Schlüssel bleiben gesperrt.
const MCP_ALLOWED = ['/api/docs', '/api/jira'];

function mcpAllowed(req) {
  const base = req.baseUrl || '';
  return MCP_ALLOWED.some(p => base === p || base.startsWith(p + '/'));
}

export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }
  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
  if (payload.via === 'mcp' && !mcpAllowed(req)) {
    return res.status(403).json({ error: 'Über die KI Verbindung nicht erlaubt' });
  }
  const id = payload.id ?? payload.userId;
  const db = req.app?.locals?.db;
  if (db && id) {
    const currentUser = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id);
    if (!currentUser) {
      return res.status(401).json({ error: 'Unauthorized: User no longer exists' });
    }
    req.user = { ...payload, id: currentUser.id, username: currentUser.username, role: currentUser.role };
  } else {
    req.user = payload;
  }
  next();
}

export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    const payload = verifyToken(token);
    if (payload && payload.via !== 'mcp') req.user = payload;
  }
  next();
}
