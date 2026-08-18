#!/usr/bin/env node
/**
 * Script de validation i18n - Vérifie que toutes les clés existent dans en.json et fr.json
 */

const fs = require('fs');
const path = require('path');

const LOCALES_DIR = path.join(__dirname, '../src/i18n/locales');
const EN_FILE = path.join(LOCALES_DIR, 'en.json');
const FR_FILE = path.join(LOCALES_DIR, 'fr.json');

// Charge les fichiers JSON
const enData = JSON.parse(fs.readFileSync(EN_FILE, 'utf8'));
const frData = JSON.parse(fs.readFileSync(FR_FILE, 'utf8'));

// Fonction récursive pour extraire toutes les clés
function extractKeys(obj, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...extractKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

const enKeys = new Set(extractKeys(enData));
const frKeys = new Set(extractKeys(frData));

// Clés manquantes dans FR
const missingInFr = [...enKeys].filter(k => !frKeys.has(k));
// Clés manquantes dans EN
const missingInEn = [...frKeys].filter(k => !enKeys.has(k));

let hasErrors = false;

if (missingInFr.length > 0) {
  console.error('Clés manquantes dans fr.json:');
  missingInFr.forEach(k => console.error(`   - ${k}`));
  hasErrors = true;
}

if (missingInEn.length > 0) {
  console.error('Clés manquantes dans en.json:');
  missingInEn.forEach(k => console.error(`   - ${k}`));
  hasErrors = true;
}

if (!hasErrors) {
  console.log('Tous les fichiers i18n sont synchronisés!');
  console.log(`Total: ${enKeys.size} clés dans chaque langue`);
  process.exit(0);
} else {
  console.error('\nSynchronisation i18n échouée');
  process.exit(1);
}
