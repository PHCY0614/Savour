/**
 * Builds the Chrome Web Store upload: dist/savour-v<version>.zip with only the files the extension runs.
 *
 * The package is a whitelist (PACKAGE_ENTRIES), so tests, node_modules, docs and dev configs never ship.
 * Before writing, every file that manifest.json, the HTML pages and the scripts refer to is checked to be
 * inside the package; a missing one stops the build instead of producing a broken upload.
 *
 * Usage: npm run pack
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// Everything the extension needs at run time. Directories are included whole.
const PACKAGE_ENTRIES = [
  "manifest.json",
  "background.js",
  "_locales",
  "background",
  "content",
  "i18n",
  "icons",
  "lib",
  "model",
  "notion",
  "pages",
  "queue",
  "storage",
  "vendor"
];

// Files inside the whitelisted directories that still have no place in the upload.
const EXCLUDED_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const EXCLUDED_EXTENSIONS = new Set([".map", ".ts", ".log"]);

function toPosix(/** @type {string} */ relative) {
  return relative.split(path.sep).join("/");
}

/** @returns {string[]} package-relative paths, POSIX style, sorted */
function collectFiles() {
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ absolute) => {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) walk(path.join(absolute, name));
      return;
    }
    const name = path.basename(absolute);
    if (EXCLUDED_NAMES.has(name) || EXCLUDED_EXTENSIONS.has(path.extname(name).toLowerCase())) return;
    files.push(toPosix(path.relative(ROOT, absolute)));
  };
  for (const entry of PACKAGE_ENTRIES) {
    const absolute = path.join(ROOT, entry);
    if (!fs.existsSync(absolute)) throw new Error(`Package entry not found: ${entry}`);
    walk(absolute);
  }
  return files.sort();
}

/**
 * Files referenced from manifest.json, HTML pages and scripts that exist in the repository but are not
 * in the package. Script references are package-root relative (importScripts, chrome.scripting);
 * HTML references are relative to the page.
 * @param {string[]} files
 * @returns {string[]}
 */
function findMissingReferences(files) {
  const packaged = new Set(files);
  /** @type {Set<string>} */
  const missing = new Set();
  const check = (/** @type {string} */ reference, /** @type {string} */ fromDir) => {
    if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
    for (const base of [fromDir, ""]) {
      const candidate = path.posix.normalize(path.posix.join(base, reference));
      if (candidate.startsWith("..")) continue;
      if (packaged.has(candidate)) return;
      if (fs.existsSync(path.join(ROOT, candidate)) && fs.statSync(path.join(ROOT, candidate)).isFile()) {
        missing.add(candidate);
        return;
      }
    }
  };

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const manifestRefs = [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
    manifest.action?.default_popup,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts ?? []).flatMap((/** @type {any} */ entry) => [...(entry.js ?? []), ...(entry.css ?? [])])
  ].filter(Boolean);
  for (const reference of manifestRefs) {
    if (!packaged.has(reference)) missing.add(reference);
  }

  const literal = /["'`]([\w./-]+\.(?:js|css|html|png|json))["'`]/g;
  const htmlAttr = /\b(?:src|href)\s*=\s*"([^"]+)"/g;
  for (const file of files) {
    const ext = path.extname(file);
    if (![".js", ".html", ".css"].includes(ext) || file.startsWith("vendor/")) continue;
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const fromDir = path.posix.dirname(file);
    for (const match of text.matchAll(ext === ".html" ? htmlAttr : literal)) check(match[1], fromDir);
  }
  return [...missing].sort();
}

// ---- ZIP writer (stored names in UTF-8, deflated data) ------------------------------------------

function dosDateTime(/** @type {Date} */ date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const { time, day } = dosDateTime(new Date());
  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const body = useDeflate ? compressed : data;
    const crc = zlib.crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  if (manifest.version !== pkg.version) {
    throw new Error(`manifest.json version ${manifest.version} does not match package.json version ${pkg.version}`);
  }

  const files = collectFiles();
  const missing = findMissingReferences(files);
  if (missing.length) {
    throw new Error(`Referenced files are not in the package:\n  ${missing.join("\n  ")}`);
  }

  const zip = buildZip(files.map(name => ({ name, data: fs.readFileSync(path.join(ROOT, name)) })));
  fs.mkdirSync(DIST, { recursive: true });
  const output = path.join(DIST, `savour-v${manifest.version}.zip`);
  fs.writeFileSync(output, zip);
  console.log(`Packaged ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB -> ${toPosix(path.relative(ROOT, output))}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  }
}

module.exports = { PACKAGE_ENTRIES, collectFiles, findMissingReferences, buildZip };
