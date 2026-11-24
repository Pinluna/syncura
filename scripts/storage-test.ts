import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(process.argv[1]);

async function runChild(mode: string) {
  if (mode === "write") {
    const { createUser } = await import("../server/store.js");
    createUser({
      name: "Sensitive test user",
      sex: "female",
      dateOfBirth: "1990-01-01",
      publicKey: "sensitive-test-public-key",
    });
    await new Promise((resolveWrite) => setTimeout(resolveWrite, 180));
    return;
  }

  if (mode === "read") {
    const { db } = await import("../server/store.js");
    console.log(JSON.stringify(db));
    return;
  }

  throw new Error(`Unknown child mode: ${mode}`);
}

function child(mode: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", "tsx", scriptPath, mode], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
  });
}

async function main() {
  if (process.argv[2]) {
    await runChild(process.argv[2]);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "syncura-storage-test-"));
  try {
    const dataPath = join(root, "syncura.json");
    const key = randomBytes(32).toString("base64");
    const env = {
      ...process.env,
      NODE_ENV: "test",
      SYNCURA_DATA_FILE: dataPath,
      SYNCURA_DATA_KEY: key,
    };

    const written = child("write", env);
    assert.equal(written.status, 0, written.stderr);
    const encrypted = readFileSync(dataPath, "utf8");
    assert.ok(encrypted.startsWith("SYNCURA-DB-ENC-V1\n"));
    assert.ok(!encrypted.includes("Sensitive test user"));

    const loaded = child("read", env);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.ok(loaded.stdout.includes("Sensitive test user"));

    const wrongKey = child("read", {
      ...env,
      SYNCURA_DATA_KEY: randomBytes(32).toString("base64"),
    });
    assert.notEqual(wrongKey.status, 0);
    assert.ok(wrongKey.stderr.includes("could not be decrypted"));
    assert.equal(readFileSync(dataPath, "utf8"), encrypted);

    const legacyPath = join(root, "legacy.json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        users: { legacy: { name: "Legacy test user" } },
        tokens: {},
        links: {},
      }),
      { mode: 0o600 },
    );
    const migrated = child("read", { ...env, SYNCURA_DATA_FILE: legacyPath });
    assert.equal(migrated.status, 0, migrated.stderr);
    assert.ok(migrated.stdout.includes("Legacy test user"));
    assert.ok(readFileSync(legacyPath, "utf8").startsWith("SYNCURA-DB-ENC-V1\n"));

    const corruptPath = join(root, "corrupt.json");
    writeFileSync(corruptPath, "{not-json", { mode: 0o600 });
    const corrupt = child("read", {
      ...env,
      SYNCURA_DATA_FILE: corruptPath,
      SYNCURA_DATA_KEY: "",
    });
    assert.notEqual(corrupt.status, 0);
    assert.ok(corrupt.stderr.includes("refusing to start with an empty database"));
    assert.equal(readFileSync(corruptPath, "utf8"), "{not-json");

    console.log("PASS encrypted storage, key verification, legacy migration, and corrupt-file protection");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
