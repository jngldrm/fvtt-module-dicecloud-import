const PACKAGE_ID = process.env.FOUNDRY_PACKAGE_ID;
const RELEASE_TOKEN = process.env.FOUNDRY_RELEASE_TOKEN;

const MODULE_VERSION = process.env.MODULE_VERSION;
const MANIFEST_URL = process.env.MANIFEST_URL;
const NOTES_URL = process.env.NOTES_URL;
const MINIMUM_COMPATIBILITY = process.env.MINIMUM_COMPATIBILITY;
const VERIFIED_COMPATIBILITY = process.env.VERIFIED_COMPATIBILITY;
const MAXIMUM_COMPATIBILITY = process.env.MAXIMUM_COMPATIBILITY;

function missingEnv(name) {
  console.warn(`[Foundry Release] Missing required environment variable: ${name}`);
}

function toNullable(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() === "" ? null : value;
  }

  return value;
}

async function createAndPushFoundryRelease() {
  if (!RELEASE_TOKEN) {
    console.log("[Foundry Release] No FOUNDRY_RELEASE_TOKEN provided, skipping Foundry Hub publication.");
    return;
  }

  if (!PACKAGE_ID) {
    missingEnv("FOUNDRY_PACKAGE_ID");
    return;
  }
  if (!MODULE_VERSION) {
    missingEnv("MODULE_VERSION");
    return;
  }
  if (!MANIFEST_URL) {
    missingEnv("MANIFEST_URL");
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: RELEASE_TOKEN,
  };

  const releasePayload = {
    id: PACKAGE_ID,
    "dry-run": false,
    release: {
      version: MODULE_VERSION,
      manifest: MANIFEST_URL,
      notes: toNullable(NOTES_URL),
      compatibility: {
        minimum: toNullable(MINIMUM_COMPATIBILITY),
        verified: toNullable(VERIFIED_COMPATIBILITY),
        maximum: toNullable(MAXIMUM_COMPATIBILITY),
      },
    },
  };

  console.log("[Foundry Release] Creating release with payload:", JSON.stringify(releasePayload, null, 2));

  const response = await fetch("https://api.foundryvtt.com/_api/packages/release_version/", {
    method: "POST",
    headers,
    body: JSON.stringify(releasePayload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Foundry release failed with status ${response.status}: ${text}`);
  }

  const responseData = await response.json();
  console.log("[Foundry Release] Release created:", JSON.stringify(responseData, null, 2));
}

createAndPushFoundryRelease().catch((error) => {
  console.error("[Foundry Release] Error while publishing:", error);
  process.exitCode = 1;
});
