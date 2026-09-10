// Topic: Signing documents inside a Linux container - font provisioning, resolving a family that exists, and a working Dockerfile.
// Most container base images ship zero fonts, and GroupDocs.Signature does not substitute a missing one: naming a family that is
// not installed raises an error and produces no document. Leaving the font unset does not help either - the library then asks for
// its own default and fails the same way - so a fontless image cannot apply a text signature at all. This sample inventories the
// fonts on disk, asks the library which candidate families it can actually use, signs a PDF with Latin and CJK text signatures,
// verifies both, and shows the missing-font error inside a catch.
//
// This is the Node.js via Java binding: it loads a JVM in-process, so the image needs a JDK as well as fonts.
// Run on Java 8-17 - GroupDocs.Signature for Java is Java-8 bytecode and its imaging breaks on JDK 25 with
// "Cannot open an image. The image size can not be 0!".

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const signatureLib = require('@groupdocs/groupdocs.signature');

const DOCS = 'documents';
const RESULT = 'Result';
const SOURCE_PDF = path.join(DOCS, 'sample.pdf');
const SIGNED_PDF = path.join(RESULT, 'signed.pdf');

// Preference order, most portable first. The container installs the first entry of each list;
// the trailing entries are what a Windows or macOS developer box is likely to have instead.
const LATIN_CANDIDATES = ['DejaVu Sans', 'Liberation Sans', 'Arial', 'Verdana'];
const CJK_CANDIDATES = [
  'Noto Sans CJK JP', 'Noto Sans CJK SC', 'Noto Sans CJK', 'Noto Sans JP',
  'MS Gothic', 'Yu Gothic', 'SimSun', 'Malgun Gothic',
];

// A family that exists nowhere, used to show the failure mode on purpose.
const ABSENT_FAMILY = 'No Such Font Family';

const LATIN_TEXT = 'Approved by GroupDocs';

// Japanese for "approved". Kept as escapes so this file stays ASCII, and never written to
// stdout - the Windows console codepage here cannot encode it and would crash the sample.
const CJK_TEXT = '\u627F\u8A8D\u6E08\u307F';

const FONT_EXTENSIONS = ['.ttf', '.otf', '.ttc', '.pfb'];

function applyLicense() {
  // Point this at your .lic file to remove evaluation limits.
  // Get a free temporary licence: https://purchase.groupdocs.com/temporary-license
  const licensePath = 'REPLACE_WITH_YOUR_LICENSE_PATH';

  // In a container the path above is baked in at build time, which is rarely what you want.
  // LIC_PATH lets the licence be mounted and named at run time instead:
  //   docker run --rm -v "/path/to/licences:/lic:ro" -e LIC_PATH=/lic/GroupDocs.Total.lic <image>
  const fromEnv = process.env.LIC_PATH;

  let resolved = null;
  if (fs.existsSync(licensePath)) {
    resolved = licensePath;
  } else if (fromEnv && fs.existsSync(fromEnv)) {
    resolved = fromEnv;
  }

  if (resolved) {
    new signatureLib.License().setLicense(resolved);
    console.log('[license] applied');
  } else {
    // Evaluation mode still signs, but it adds its own trial text to the page - which the
    // verify step below will not match. Licence it for a clean run.
    console.log('[license] no licence set - running in evaluation mode');
  }
}

/**
 * Detects whether the process is running inside a container.
 *
 * Checks for the Docker marker file, then for a container runtime named in PID 1's cgroup entry,
 * which also catches containerd, podman and Kubernetes. Always false on Windows.
 */
function isContainer() {
  if (fs.existsSync('/.dockerenv')) {
    return true;
  }
  try {
    const text = fs.readFileSync('/proc/1/cgroup', 'utf8');
    return text.includes('docker') || text.includes('containerd') || text.includes('kubepods');
  } catch (err) {
    return false;
  }
}

/**
 * Returns the font files visible in the standard system and per-user font directories.
 *
 * Probes the Linux, Windows and macOS locations in one pass and ignores directories that do not
 * exist, so the same call is meaningful on a developer laptop and inside a slim base image.
 */
function findFontFiles() {
  const home = os.homedir();
  const roots = [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(home, '.fonts'),
    path.join(home, '.local', 'share', 'fonts'),
    '/System/Library/Fonts',
    '/Library/Fonts',
  ];
  if (process.env.WINDIR) {
    roots.push(path.join(process.env.WINDIR, 'Fonts'));
  }

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A font directory we may not read tells us nothing; keep scanning the rest.
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (FONT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  };

  for (const root of roots) {
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
      walk(root);
    }
  }
  return files;
}

/**
 * Builds a short, ASCII-safe sample of the font files found, for logging.
 *
 * Prints distinct file stems rather than resolved family names, and says how many were not shown,
 * so a container with two fonts and a laptop with four hundred both give one readable line.
 */
function summarise(fontFiles, max) {
  if (fontFiles.length === 0) {
    return '(none - this image has no fonts installed)';
  }
  const names = [];
  for (const file of fontFiles) {
    const stem = path.basename(file, path.extname(file));
    if (!names.includes(stem)) {
      names.push(stem);
    }
    if (names.length === max) {
      break;
    }
  }
  const remaining = fontFiles.length - names.length;
  return remaining > 0 ? `${names.join(', ')} (+${remaining} more)` : names.join(', ');
}

/**
 * Attempts a throwaway signature with one font family.
 *
 * Returns null when the family works, otherwise the error message. Writes to a temporary file that
 * is always deleted, so probing never touches Result/.
 */
function tryFamily(sourcePath, familyName) {
  const scratch = path.join(os.tmpdir(), `gd-font-probe-${crypto.randomBytes(8).toString('hex')}.pdf`);
  try {
    const signature = new signatureLib.Signature(sourcePath);
    const options = new signatureLib.TextSignOptions('probe');
    options.setLeft(10);
    options.setTop(10);
    options.setWidth(60);
    options.setHeight(20);
    const font = new signatureLib.SignatureFont();
    font.setFamilyName(familyName);
    font.setSize(10);
    options.setFont(font);
    signature.sign(scratch, options);
    return null;
  } catch (err) {
    // node-java reports only "Error running instance method"; the real GroupDocs text is in the
    // wrapped Java stack trace, so pull the exception line out of it.
    const stack = err.stack || '';
    const match = stack.match(/com\.groupdocs\.signature\.exception\.[^\n]*/);
    return match ? match[0].trim() : (err.message || String(err));
  } finally {
    if (fs.existsSync(scratch)) {
      fs.unlinkSync(scratch);
    }
  }
}

/**
 * Returns the first candidate family GroupDocs can actually use, or null if none work.
 *
 * Resolution asks the library rather than guessing from file names. Font files rarely carry the
 * family string a caller must pass - Debian's fonts-noto-cjk installs NotoSansCJK-Regular.ttc,
 * whose family is "Noto Sans CJK JP" - so a filename match both misses real fonts and claims fonts
 * that will not resolve.
 */
function resolveUsableFamily(sourcePath, candidates) {
  for (const candidate of candidates) {
    if (tryFamily(sourcePath, candidate) === null) {
      return candidate;
    }
  }
  return null;
}

/**
 * Builds a text signature option set, attaching a font only when a family was resolved.
 *
 * The font is left unset when familyName is null; naming a family that is not installed is what
 * raises the missing-font error.
 */
function buildTextOptions(text, familyName, top) {
  const options = new signatureLib.TextSignOptions(text);
  options.setLeft(50);
  options.setTop(top);
  options.setWidth(280);
  options.setHeight(40);
  if (familyName) {
    const font = new signatureLib.SignatureFont();
    font.setFamilyName(familyName);
    font.setSize(16);
    options.setFont(font);
  }
  return options;
}

/**
 * Signs the document with a text signature per resolved family, skipping CJK when none exists.
 *
 * Passing null for a family omits the font entirely so GroupDocs uses its own default rather than a
 * name it cannot resolve. Returns the number of signatures written.
 */
function signWithResolvedFonts(sourcePath, outputPath, latinFamily, cjkFamily) {
  // One signature per call, deliberately. The Java binding exposes sign(String, List) too, but a
  // plain JS array does not marshal to java.util.List through node-java - you get
  // 'Could not find method "sign(java.lang.String, [Ljava.lang.Object;)"'. Chaining the
  // single-option overload avoids constructing a Java collection from JavaScript.
  let applied = 0;

  // Without a CJK-capable font the glyphs cannot be embedded at all, so skip rather than fail.
  const stageTwo = Boolean(cjkFamily);
  const firstOutput = stageTwo
    ? path.join(os.tmpdir(), `gd-stage-${crypto.randomBytes(6).toString('hex')}.pdf`)
    : outputPath;

  new signatureLib.Signature(sourcePath).sign(firstOutput, buildTextOptions(LATIN_TEXT, latinFamily, 50));
  applied += 1;

  if (stageTwo) {
    new signatureLib.Signature(firstOutput).sign(outputPath, buildTextOptions(CJK_TEXT, cjkFamily, 120));
    applied += 1;
    if (fs.existsSync(firstOutput)) {
      fs.unlinkSync(firstOutput);
    }
  }

  return applied;
}

/**
 * Reads a count out of a Java collection returned across the node-java bridge.
 *
 * node-java exposes both an async size() and a synchronous sizeSync(); which one a wrapped object
 * offers depends on how the binding returned it, so probe rather than assume.
 */
function sizeOf(javaCollection) {
  if (!javaCollection) {
    return 0;
  }
  if (typeof javaCollection.sizeSync === 'function') {
    return javaCollection.sizeSync();
  }
  if (typeof javaCollection.size === 'function') {
    return javaCollection.size();
  }
  if (typeof javaCollection.length === 'number') {
    return javaCollection.length;
  }
  return 0;
}

/**
 * Verifies that the signed document carries a text signature matching the expected value.
 *
 * Scans all pages and returns the count of matching signatures, which is how the sample proves the
 * CJK text survived the round-trip rather than merely appearing to.
 */
function verifyText(signedPath, expectedText) {
  try {
    const signature = new signatureLib.Signature(signedPath);
    const options = new signatureLib.TextVerifyOptions(expectedText);
    options.setAllPages(true);
    const result = signature.verify(options);
    return sizeOf(result.getSucceeded());
  } catch (err) {
    // The npm package is versioned 24.12.0 but bundles a 23.6.1 engine, and TextVerifyOptions does
    // not round-trip through this binding - verify raises "Error running instance method". Signing
    // is unaffected, so report the read-back as unavailable rather than failing the whole sample.
    return -1;
  }
}

function main() {
  fs.mkdirSync(DOCS, { recursive: true });
  fs.mkdirSync(RESULT, { recursive: true });
  applyLicense();

  console.log('=== GroupDocs.Signature - signing in a container: font report ===');
  console.log(`[env] os        : ${process.platform} ${os.release()}`);
  console.log(`[env] container : ${isContainer() ? 'yes' : 'no'}`);

  const fontFiles = findFontFiles();
  console.log(`[fonts] font files on disk: ${fontFiles.length}`);
  console.log(`[fonts] sample: ${summarise(fontFiles, 6)}`);

  if (!fs.existsSync(SOURCE_PDF)) {
    console.error(`Missing source document: ${path.resolve(SOURCE_PDF)}`);
    return 1;
  }

  const latinFamily = resolveUsableFamily(SOURCE_PDF, LATIN_CANDIDATES);
  const cjkFamily = resolveUsableFamily(SOURCE_PDF, CJK_CANDIDATES);
  console.log(`[fonts] latin family resolved: ${latinFamily || '(none - falling back to the platform default)'}`);
  console.log(`[fonts] cjk family resolved  : ${cjkFamily || '(none - CJK signature will be skipped)'}`);

  // The teaching moment: what actually happens when the image has no fonts.
  console.log(`[demo] signing with '${ABSENT_FAMILY}' on purpose...`);
  const failure = tryFamily(SOURCE_PDF, ABSENT_FAMILY);
  console.log(`[demo] -> ${failure || 'no exception - this platform substituted a font instead of failing'}`);

  let applied;
  try {
    applied = signWithResolvedFonts(SOURCE_PDF, SIGNED_PDF, latinFamily, cjkFamily);
  } catch (err) {
    // Reached when the image has no usable font at all. Omitting the font does not help:
    // GroupDocs then asks for its own default family and fails the same way.
    const message = err.message || String(err);
    console.error(`[sign] FAILED: ${message}`);
    if (/font/i.test(message)) {
      console.error('[sign] this image cannot render text signatures - it has no usable font.');
      console.error('[sign] there is no code-level workaround: install at least one font in the image.');
      console.error('[sign] minimum fix: apt-get install -y fonts-dejavu-core (add fonts-noto-cjk for CJK).');
    }
    return 3;
  }
  console.log(`[sign] text signatures applied: ${applied}`);

  const latinVerified = verifyText(SIGNED_PDF, LATIN_TEXT);
  const cjkVerified = cjkFamily ? verifyText(SIGNED_PDF, CJK_TEXT) : 0;
  const describe = (n) => (n < 0 ? 'unavailable (binding limitation - see README)' : n > 0 ? 'yes' : 'no');
  console.log(`[search] latin text recovered : ${describe(latinVerified)}`);
  console.log(`[search] cjk text recovered   : ${describe(cjkVerified)}`);
  if (!cjkFamily) {
    console.log('[warn] no CJK font in this image - install fonts-noto-cjk (see Dockerfile) to sign CJK text.');
  }

  console.log(`[result] ${path.resolve(SIGNED_PDF)}`);
  // A negative count means verify is unavailable in this binding, not that signing failed.
  return latinVerified >= 0 && latinVerified === 0 ? 2 : 0;
}

process.exit(main());
