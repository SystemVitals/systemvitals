import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirectory = mkdtempSync(join(tmpdir(), "systemvitals-mcp-pack-"));
const packOutput = JSON.parse(
  execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", tempDirectory],
    { cwd: new URL("..", import.meta.url), encoding: "utf8" },
  ),
);
const packed = packOutput[0];
const paths = packed.files.map((file) => file.path);

if (!paths.includes("dist/cli/mcp.js")) {
  throw new Error("Packed tarball does not include dist/cli/mcp.js");
}
if (paths.some((path) => path.includes("/test/") || path.endsWith(".test.js"))) {
  throw new Error("Packed tarball includes test output");
}

const tarball = join(tempDirectory, packed.filename);
execFileSync("npm", ["init", "-y"], { cwd: tempDirectory, stdio: "ignore" });
execFileSync("npm", ["install", "--ignore-scripts", tarball], {
  cwd: tempDirectory,
  stdio: "ignore",
});

const cli = join(tempDirectory, "node_modules", ".bin", "systemvitals-mcp");
const cliSource = readFileSync(
  join(tempDirectory, "node_modules", "@systemvitals", "mcp", "dist", "cli", "mcp.js"),
  "utf8",
);
if (!cliSource.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("Packed CLI does not preserve the Node shebang");
}
if ((statSync(cli).mode & 0o111) === 0) {
  throw new Error("Packed CLI shim is not executable");
}

const result = spawnSync(cli, [], {
  cwd: tempDirectory,
  env: { PATH: process.env.PATH ?? "" },
  encoding: "utf8",
});
if (result.status !== 1) {
  throw new Error(`Packed CLI exited ${result.status}; stderr: ${result.stderr}`);
}
if (!result.stderr.includes("SYSTEMVITALS_API_URL is not set")) {
  throw new Error(`Packed CLI did not report a safe missing-env error: ${result.stderr}`);
}
if (/SyntaxError|ERR_MODULE_NOT_FOUND/.test(result.stderr)) {
  throw new Error(`Packed CLI failed to load: ${result.stderr}`);
}

console.log(`pack smoke passed: ${packed.filename}, ${packed.files.length} files`);
