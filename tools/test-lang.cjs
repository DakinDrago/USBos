/* USBos — tools/test-lang.cjs : runtime tests i18n (node, sans navigateur).
 * Charge le VRAI kernel.js avec des stubs DOM minimaux + les VRAIS dicts
 * fr/en du dépôt, puis vérifie t()/tp()/bt()/validateLangPack().
 * Usage : node tools/test-lang.cjs  (exit 1 si échec)
 * Compte : N eq() comptés dynamiquement (affichés en fin de run) + sondes
 * tx/bt hors compteur. Les valeurs attendues en dur sont recopiées des
 * dicts (source indiquée en commentaire : en.json / fr.json <chemin>).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FR = JSON.parse(fs.readFileSync(path.join(ROOT, 'USBos/system/lang/fr.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'USBos/system/lang/en.json'), 'utf8'));

let failures = 0;
let assertions = 0;
function eq(actual, expected, label) {
  assertions++;
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.log(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${label}`);
  }
}

// ---- stubs navigateur minimaux (boot non déclenché : readyState loading) ----
const store = {};
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  crypto: require('crypto').webcrypto,
  TextEncoder, TextDecoder,
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  document: {
    readyState: 'loading',
    documentElement: { dataset: {}, lang: '' },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => { throw new Error('no DOM in test'); },
    body: { append: () => {} },
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(ROOT, 'USBos/system/kernel.js'), 'utf8');
vm.runInContext(code + '\n;globalThis.__K = window.USBosKernel;', sandbox, { filename: 'kernel.js' });
const K = sandbox.__K;

// ---- injecte les vrais dicts (même enveloppe {dict} que loadLangs) ----
K.state.dicts = { fr: { dict: FR }, en: { dict: EN } };
K.state.uiPrefs = { lang: 'fr', radius: 'doux', fs: 'm', density: 'confort', barpos: 'haut', side: 'droite' };

// 1. t() de base + interpolation (sources: fr/en.json shell.lock.unlockBtn,
//    en.json shell.dash.key, en.json shell.update.available — clés vérifiées
//    présentes dans les deux dicts par tools/validate-lang.py)
eq(K.t('shell.lock.unlockBtn'), 'Déverrouiller', 't fr');
K.state.uiPrefs.lang = 'en';
eq(K.t('shell.lock.unlockBtn'), 'Unlock', 't en');
eq(K.t('shell.dash.key', { name: 'X' }), 'Key: X', 't params en');
eq(K.t('shell.update.available', { summary: '1.2.3' }), 'Available: 1.2.3', 't params 2');
// 2. repli lang -> en -> fr -> clé (sondes injectées puis retirées en finally
//    pour ne jamais polluer les dicts partagés en cas d'échec intermédiaire)
K.state.dicts.en.dict.shell.lock.probeOnlyEn = 'EN only';
try {
  eq(K.t('shell.lock.probeOnlyEn'), 'EN only', 'fallback en');
} finally {
  delete K.state.dicts.en.dict.shell.lock.probeOnlyEn;
}
K.state.dicts.fr.dict.shell.lock.probeOnlyFr = 'FR seulement';
try {
  eq(K.t('shell.lock.probeOnlyFr'), 'FR seulement', 'fallback fr');
} finally {
  delete K.state.dicts.fr.dict.shell.lock.probeOnlyFr;
}
eq(K.t('shell.nope.missing'), 'shell.nope.missing', 'fallback key');
// 3. tp() pluriels (sources: fr/en.json shell.dash.appsCount,
//    en.json shell.errors.migrated, en.json notes.countChars)
K.state.uiPrefs.lang = 'fr';
eq(K.tp('shell.dash.appsCount', 1), '1 app', 'tp fr one');
eq(K.tp('shell.dash.appsCount', 3), '3 apps', 'tp fr other');
K.state.uiPrefs.lang = 'en';
eq(K.tp('shell.dash.appsCount', 0), '0 apps', 'tp en zero=other');
eq(K.tp('shell.errors.migrated', 1), '1 file encrypted.', 'tp en one');
eq(K.tp('notes.countChars', 0), '0 characters', 'tp app namespace en');
// 4. locales
K.state.uiPrefs.lang = 'en';
eq(K.langLocale(), 'en-US', 'locale en');
K.state.uiPrefs.lang = 'fr';
eq(K.langLocale(), 'fr-FR', 'locale fr');
// 5. customs : validate + locale + repli
const esPack = { kind: 'usbos-lang', lang: 'es', locale: 'es-ES', dict: { shell: { lock: { unlockBtn: 'Desbloquear' } } } };
eq(K.validateLangPack(esPack), null, 'custom valid');
K.state.uiPrefs.lang = 'en';
eq(K.validateLangPack({ kind: 'nope', lang: 'es', dict: {} }), 'Not a USBos language pack.', 'custom bad kind (en)');
eq(K.validateLangPack({ kind: 'usbos-lang', lang: 'fr', dict: {} }), 'Native language (not replaceable).', 'custom native refused');
eq(K.validateLangPack({ kind: 'usbos-lang', lang: 'xx!', dict: {} }), 'Invalid language code (e.g. es, pt-BR).', 'custom bad code');
eq(K.validateLangPack({ kind: 'usbos-lang', lang: 'es' }), 'Missing dictionary.', 'custom no dict');
eq(K.validateLangPack({ kind: 'usbos-lang', lang: 'es', dict: { a: '<script>' } }), 'Forbidden content (<script).', 'custom script refused');
eq(K.validateLangPack({ kind: 'usbos-lang', lang: 'es', dict: { a: 'x'.repeat(201 * 1024) } }) !== null, true, 'custom oversize refused');
K.state.dicts.es = { locale: 'es-ES', dict: esPack.dict };
K.state.uiPrefs.lang = 'es';
eq(K.currentLang(), 'es', 'currentLang custom');
eq(K.langLocale(), 'es-ES', 'locale custom');
eq(K.t('shell.lock.unlockBtn'), 'Desbloquear', 't custom');
eq(K.t('shell.lock.wrongPass'), 'Incorrect passphrase.', 't custom fallback en (lang->en->fr)');
K.state.dicts.fr.dict.shell.lock.probeOnlyFr = 'FR seulement';
try {
  eq(K.t('shell.lock.probeOnlyFr'), 'FR seulement', 't custom fallback fr (lang->en->fr)');
} finally {
  delete K.state.dicts.fr.dict.shell.lock.probeOnlyFr;
}
K.state.uiPrefs.lang = 'fr';
delete K.state.dicts.es;
// 6. bt() pré-vfs via indice localStorage (sources: fr/en.json
//    shell.connect.title) ; tx sondé hors compteur eq()
sandbox.localStorage.setItem('usbos-lang-hint', 'en');
eq(K.tx ? 'has-tx' : 'no-tx', 'has-tx', 'tx exposed');
// bt n'est pas exposée ? elle doit l'être pour le test :
if (typeof sandbox.__BT__ === 'undefined') {
  // récupérée via une seconde passe : on évalue l'expression dans le contexte
  try {
    const bt = vm.runInContext('bt', sandbox);
    eq(bt('shell.connect.title'), 'Power on USBos', 'bt en via hint');
    sandbox.localStorage.setItem('usbos-lang-hint', 'fr');
    eq(bt('shell.connect.title'), 'Allumer USBos', 'bt fr via hint');
  } catch (e) {
    failures++;
    console.log('FAIL bt not reachable: ' + e.message);
  }
}
// 7. setLang persiste + repeint le chrome (stubs neutres)
(async () => {
  await K.setLang('en');
  eq(K.state.uiPrefs.lang, 'en', 'setLang persists');
  eq(store['usbos-lang-hint'], 'en', 'setLang writes hint');
  eq(sandbox.document.documentElement.lang, 'en', 'setLang sets <html lang>');
  await K.setLang('fr');
  eq(K.state.uiPrefs.lang, 'fr', 'setLang back to fr');
  console.log(failures ? `\n${failures} FAILURE(S) (${assertions} assertions)` : `\nALL LANG RUNTIME TESTS PASSED (${assertions} assertions + tx/bt probes)`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + (e && e.stack || e)); process.exit(1); });
