// Loads optional .argus/config.yml from the target repo being reviewed.
// Falls back to safe defaults if the file is absent or malformed.

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * @typedef {Object} ArgusConfig
 * @property {'INFO'|'SUGGESTION'|'WARNING'|'CRITICAL'} severity_threshold
 * @property {number}   max_comments
 * @property {string[]} ignore_paths
 */

/** @type {ArgusConfig} */
const DEFAULTS = {
  severity_threshold: 'INFO',
  max_comments: 15,
  ignore_paths: [],
};

/**
 * Reads and merges .argus/config.yml from GITHUB_WORKSPACE.
 * Unknown keys in the file are silently ignored (spread keeps only merged keys).
 * @returns {ArgusConfig}
 */
function loadConfig() {
  const configPath = path.join(
    process.env.GITHUB_WORKSPACE || '.',
    '.argus',
    'config.yml'
  );

  try {
    if (!fs.existsSync(configPath)) {
      console.log(`Argus: no config found at ${configPath}, using defaults`);
      return { ...DEFAULTS };
    }

    const file   = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(file);

    if (!parsed || typeof parsed !== 'object') {
      console.log('Argus: config.yml is empty or invalid, using defaults');
      return { ...DEFAULTS };
    }

    const merged = { ...DEFAULTS, ...parsed };
    console.log(`Argus: loaded config from ${configPath}`);
    return merged;

  } catch (e) {
    console.log(`Argus: could not read .argus/config.yml (${e.message}), using defaults`);
    return { ...DEFAULTS };
  }
}

module.exports = { loadConfig };
