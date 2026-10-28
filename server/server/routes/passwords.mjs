import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.mjs';
import {
  VaultError, listEntries, listFolders, getEntry, entryHistory, createEntry, updateEntry, deleteEntry,
  createFolder, renameFolder, deleteFolder, moveFolderVault,
} from '../vault/store.mjs';

// Tresor-API. Gespeichert wird in Vaultwarden (vault/store.mjs); Pfade und Antworten sind
// dieselben wie früher, damit Oberfläche und Browser-Erweiterung unverändert bleiben.
//
// Gemeinsamer und privater Tresor: Einträge und Ordner mit privatem Besitzer sieht nur dieser
// Benutzer. Für alle anderen existieren sie nicht (404), auch nicht für Admins.
const router = Router();
router.use(authMiddleware);

// Fehler aus dem Speicher in passende HTTP-Antworten übersetzen
const handle = (label, fn, status = 200) => async (req, res) => {
  try {
    res.status(status).json(await fn(req));
  } catch (error) {
    if (error instanceof VaultError) return res.status(error.status).json({ error: error.message });
    console.error(`${label} error:`, error.message);
    res.status(503).json({ error: 'Der Tresor ist gerade nicht erreichbar. Bitte gleich noch einmal versuchen.' });
  }
};

router.get('/', handle('Get passwords', req => listEntries(req.user)));
router.get('/folders', handle('Get folders', req => listFolders(req.user)));
router.post('/folders', handle('Create folder', req => createFolder(req.user, req.body || {}), 201));
router.put('/folders/:id', handle('Rename folder', req => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new VaultError(400, 'Ungültige Ordner-ID');
  return renameFolder(req.user, id, req.body || {});
}));
router.delete('/folders/:id', handle('Delete folder', req => deleteFolder(req.user, Number(req.params.id))));
// Ganzen Ordner (mit Unterordnern und Einträgen) in den anderen Tresor verschieben
router.post('/folders/:id/move-vault', handle('Move folder between vaults', req => moveFolderVault(req.user, Number(req.params.id), req.body?.private)));
router.get('/:id/history', handle('Get password history', req => entryHistory(req.user, Number(req.params.id))));
router.get('/:id', handle('Get password', req => getEntry(req.user, Number(req.params.id))));
router.post('/', handle('Create password', req => createEntry(req.user, req.body || {}), 201));
router.put('/:id', handle('Update password', req => updateEntry(req.user, Number(req.params.id), req.body || {})));
router.delete('/:id', handle('Delete password', req => deleteEntry(req.user, Number(req.params.id))));

export default router;
