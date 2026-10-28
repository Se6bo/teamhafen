// Privater Tresor: nur für die Benutzer-IDs in PRIVATE_VAULT_USERS (z. B. "1"), sonst für niemanden.
// Bewusst die ID und nicht der Benutzername, weil Admins Benutzernamen ändern können.
export function privateVaultUserIds() {
  return new Set(String(process.env.PRIVATE_VAULT_USERS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => Number.isInteger(n) && n > 0));
}

export function hasPrivateVault(userOrId) {
  const id = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  return privateVaultUserIds().has(Number(id));
}
