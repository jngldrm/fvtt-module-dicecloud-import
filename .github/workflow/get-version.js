const fs = require("fs");
const path = require("path");

/**
 * Reads a Foundry module manifest and prints its version to stdout.
 * Defaults to ./module.json but you can pass a custom path as argv[2].
 */
(function main() {
  const manifestPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("module.json");

  try {
    const contents = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(contents);
    if (!manifest.version) {
      throw new Error(`Manifest at ${manifestPath} does not contain a version field.`);
    }
    console.info(manifest.version);
  } catch (error) {
    console.error(`Unable to read version from ${manifestPath}:`, error.message);
    process.exit(1);
  }
})();
