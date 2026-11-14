#!/usr/bin/env node
// Checks the release rules in .github/release-policy.json before scripts/release.sh publishes anything:
//   1. VERSION is X.Y.Z (final) or X.Y.Z-beta.N (beta).
//   2. A final release comes after a beta of the same version, and changes nothing since the last beta
//      except the paths in "finalMayChange" (version number, changelog, docs), after "minBetaDays".
//   3. The release PR (the PR that set VERSION) was approved or merged by one of the "approvers".
// Usage: node scripts/release-policy.mjs <version> <owner/repo> [--report]   (--report: print, never fail)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [version, repo, mode] = process.argv.slice(2);
const report = mode === "--report";
const policy = JSON.parse(fs.readFileSync(new URL("../.github/release-policy.json", import.meta.url), "utf8"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const gh = (...a) => execFileSync(process.env.GH || "gh", a, { encoding: "utf8" }).trim();
const problems = [];
const ok = msg => console.log("   ok   " + msg);
const fail = msg => { problems.push(msg); console.log("   NO   " + msg); };

console.log(`== release rules (.github/release-policy.json) for ${version}`);
const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/);
if (!m) fail(`VERSION "${version}" must be X.Y.Z or X.Y.Z-beta.N`);
const isBeta = !!m?.[4];

if (m && !isBeta && policy.betaBeforeFinal) {
  const betas = git("tag", "-l", `v${version}-beta.*`).split("\n").filter(Boolean)
    .sort((a, b) => +a.split(".").pop() - +b.split(".").pop());
  if (!betas.length) fail(`no beta of ${version} yet: ship v${version}-beta.1 first (set VERSION to ${version}-beta.1 in a release PR)`);
  else {
    const last = betas[betas.length - 1];
    ok(`${betas.length} beta(s) of ${version}; last: ${last}`);
    const changed = git("diff", "--name-only", last, "HEAD").split("\n").filter(Boolean);
    const code = changed.filter(f => !policy.finalMayChange.some(p => p.endsWith("/") ? f.startsWith(p) : f === p));
    if (code.length) fail(`code changed since ${last}, so it hasn't been through a beta: ${code.slice(0, 8).join(", ")}${code.length > 8 ? ", …" : ""}. Ship another beta first.`);
    else ok(`only ${changed.length ? changed.join(", ") : "nothing"} changed since ${last}`);
    const days = (Date.now() / 1000 - +git("log", "-1", "--format=%ct", last)) / 86400;
    if (days < (policy.minBetaDays || 0)) fail(`${last} is ${days.toFixed(1)} days old; the policy wants ${policy.minBetaDays}`);
  }
}

// The release PR: whichever PR brought in the commit that last changed VERSION.
try {
  const sha = git("log", "-1", "--format=%H", "--", "VERSION");
  const prs = JSON.parse(gh("api", `repos/${repo}/commits/${sha}/pulls`, "-H", "Accept: application/vnd.github+json"))
    .filter(p => p.merged_at);
  if (!prs.length) fail(`VERSION was last changed by ${sha.slice(0, 7)}, which didn't come through a merged PR. Set it in a release PR.`);
  else {
    const pr = prs[0];
    const merged = JSON.parse(gh("api", `repos/${repo}/pulls/${pr.number}`)).merged_by?.login;
    const approvedBy = JSON.parse(gh("api", `repos/${repo}/pulls/${pr.number}/reviews`)).filter(r => r.state === "APPROVED").map(r => r.user.login);
    const who = [merged, ...approvedBy].filter(u => policy.approvers.includes(u));
    if (who.length) ok(`release PR #${pr.number} approved by ${[...new Set(who)].join(", ")}`);
    else fail(`release PR #${pr.number} needs approval or a merge by one of: ${policy.approvers.join(", ")}`);
  }
} catch (e) { fail(`couldn't check the release PR's approval (${String(e.message).split("\n")[0]})`); }

if (problems.length && !report) { console.log(`\n${problems.length} release rule(s) not met; nothing was published.`); process.exit(1); }
