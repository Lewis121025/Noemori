import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { packageExtension } from "./extension-package.mjs";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");
const profile = release ? "release" : "debug";
const target = process.env.CARGO_TARGET_DIR ? resolve(directory, process.env.CARGO_TARGET_DIR) : resolve(directory, "../target");
const runtime = join(directory, "runtime");
function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: directory, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`UI 构建失败：${command} (${result.status})`);
}
run("cargo", ["build", "--manifest-path", "../Cargo.toml", "--locked", "--bin", "noemori-ui-runtime", "--bin", "noemori-browser-host", ...(release ? ["--release"] : [])]);
mkdirSync(runtime, { recursive: true });
for (const binary of ["noemori-ui-runtime", "noemori-browser-host"]) copyFileSync(join(target, profile, binary), join(runtime, binary));

const web = resolve(directory, "../web-runtime");
run("pnpm", ["--filter", "@noemori/agent-web-runtime", "build"]);
const extension = join(runtime, "browser-extension");
packageExtension(web, extension);
const manifest = JSON.parse(readFileSync(join(extension, "manifest.json"), "utf8"));
const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
const identity = [...digest].map((value) => String.fromCharCode(97 + Number.parseInt(value, 16))).join("");
if (identity !== "adeahajhgekfhfgimpaokoahfajebajb") throw new Error("扩展稳定身份与宿主不一致");

if (process.platform === "darwin") {
  run("cargo", ["build", "--manifest-path", "../Cargo.toml", "--locked", "-p", "noemori-macos-ui", "--bin", "noemori-computer-helper", ...(release ? ["--release"] : [])], { ...process.env, MACOSX_DEPLOYMENT_TARGET: "14.0" });
  const bundle = join(runtime, "NoemoriComputerHelper.app");
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  copyFileSync(join(target, profile, "noemori-computer-helper"), join(bundle, "Contents/MacOS/noemori-computer-helper"));
  writeFileSync(join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.noemori.computer-helper</string>
<key>CFBundleName</key><string>Noemori Computer Helper</string>
<key>CFBundleDisplayName</key><string>Noemori Computer Helper</string>
<key>CFBundleExecutable</key><string>noemori-computer-helper</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`);
  const identity = process.env.NOEMORI_SIGN_IDENTITY || "-";
  run("codesign", ["--force", "--sign", identity, ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]), bundle]);
  run("codesign", ["--verify", "--strict", bundle]);
}
