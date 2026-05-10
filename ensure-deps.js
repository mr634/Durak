/**
 * Run from npm "prestart" so `ws` exists even if `npm install` was skipped
 * or this folder was copied without node_modules.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const marker = path.join(root, "node_modules", "ws", "package.json");
if (fs.existsSync(marker)) return;

console.log("Durak: installing dependencies (npm install)…");
execSync("npm install", { stdio: "inherit", cwd: root, env: process.env });
