const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const projectOwnerHpcUsername = ["r", "sharma", "3"].join("");

const forbiddenFiles = [
  /(^|\/)\.env(?:\.|$)/,
  /(^|\/)\.npmrc$/,
  /(^|\/)(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/,
  /\.(?:key|pem|p8|p12|pfx|ppk|jks|keystore|mobileprovision|provisionprofile)$/i,
];

const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{20,}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["personal macOS path", /\/Users\/[^/\s]+/],
  ["project-owner HPC username", new RegExp(`\\b${projectOwnerHpcUsername}\\b`, "i")],
];

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const findings = [];

for (const file of files) {
  if (forbiddenFiles.some((pattern) => pattern.test(file))) {
    findings.push(`${file}: credential-like file must not be tracked`);
    continue;
  }
  const stats = fs.statSync(file);
  if (stats.size > 2 * 1024 * 1024) continue;
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) findings.push(`${file}: possible ${label}`);
  }
}

if (findings.length) {
  console.error("Public repository safety check failed:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Public repository safety check passed for ${files.length} tracked files.`);
