// Lightweight LLM output validator.
// Logs findings but does NOT block delivery at this stage.

export function validate(rawOutput) {
  const errors = [];
  const warnings = [];
  const securityFlags = [];

  // ---- Parse raw output for structure checks ----
  const hasConfigDelimiter = /===\s*CONFIGURATION\s*===/.test(rawOutput);
  const hasDocsDelimiter = /===\s*DOCUMENTATION\s*===/.test(rawOutput);

  const configMatch = rawOutput.match(/===\s*CONFIGURATION\s*===\s*([\s\S]*?)(?====\s*DOCUMENTATION\s*===)/);
  const docsMatch = rawOutput.match(/===\s*DOCUMENTATION\s*===\s*([\s\S]*?)$/);

  let configText = configMatch ? configMatch[1].trim() : '';
  let docsText = docsMatch ? docsMatch[1].trim() : '';

  // Strip code fences if present
  if (configText) {
    configText = configText.replace(/^```(?:nix)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (docsText) {
    docsText = docsText.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // ---- Structure checks (errors) ----

  if (!hasConfigDelimiter) {
    errors.push('Missing === CONFIGURATION === delimiter');
  }
  if (!hasDocsDelimiter) {
    errors.push('Missing === DOCUMENTATION === delimiter');
  }
  if (!configText) {
    errors.push('Config section is empty');
  }
  if (configText) {
    // Should start with { or # (comment) eventually followed by {
    const stripped = configText.replace(/^#[^\n]*\n/gm, '').trimStart();
    if (!stripped.startsWith('{')) {
      errors.push('Config does not start with { (after comments)');
    }
  }

  // ---- Nix plausibility checks (errors) ----

  if (configText) {
    const openBraces = (configText.match(/\{/g) || []).length;
    const closeBraces = (configText.match(/\}/g) || []).length;
    if (openBraces !== closeBraces) {
      errors.push(`Unbalanced braces: ${openBraces} open, ${closeBraces} close`);
    }

    const openBrackets = (configText.match(/\[/g) || []).length;
    const closeBrackets = (configText.match(/\]/g) || []).length;
    if (openBrackets !== closeBrackets) {
      errors.push(`Unbalanced brackets: ${openBrackets} open, ${closeBrackets} close`);
    }

    const hasPackages = configText.includes('environment.systemPackages');
    const hasStateVersion = configText.includes('system.stateVersion');
    if (!hasPackages && !hasStateVersion) {
      errors.push('Missing expected markers (environment.systemPackages or system.stateVersion)');
    }

    // Truncation check: config should end with }
    const trimmedEnd = configText.trimEnd();
    if (!trimmedEnd.endsWith('}')) {
      errors.push('Config appears truncated (does not end with })');
    }
  }

  // ---- Security pattern flags (warnings) ----

  if (configText) {
    if (/networking\.firewall\.enable\s*=\s*false/.test(configText)) {
      securityFlags.push('Firewall disabled');
    }
    if (/PasswordAuthentication\s*=\s*true/.test(configText)) {
      securityFlags.push('Password SSH authentication enabled');
    }
    if (/PermitRootLogin\s*=\s*"(yes|without-password)"/.test(configText)) {
      securityFlags.push('Root SSH login enabled');
    }
    if (/builtins\.(fetchurl|fetchGit)|fetchFromGitHub/.test(configText)) {
      securityFlags.push('Network fetch in configuration (fetchurl/fetchGit/fetchFromGitHub)');
    }
  }

  // ---- Character break detection (warnings) ----

  if (hasConfigDelimiter) {
    const beforeConfig = rawOutput.split(/===\s*CONFIGURATION\s*===/)[0].trim();
    if (beforeConfig && /^(Sure|Here|Let me|I'll|Of course|Absolutely|Great|Okay|Certainly)/i.test(beforeConfig)) {
      warnings.push('Conversational preamble before config delimiter');
    }
  }

  if (configMatch) {
    const rawConfig = configMatch[1].trim();
    if (/^```/.test(rawConfig)) {
      warnings.push('Config section wrapped in code fences');
    }
  }

  return {
    passed: errors.length === 0,
    configText,
    docsText,
    errors,
    warnings,
    securityFlags,
  };
}

// ── Extraction functions (pure — no DB or side effects) ──

// Nix builtins and pkgs functions that are not installable packages
const PKG_IGNORE = new Set([
  'lib', 'callPackage', 'writeShellScript', 'writeScript', 'buildEnv',
  'runCommand', 'fetchFromGitHub', 'fetchurl', 'fetchgit', 'stdenv', 'mkShell',
  'pkgs', 'with', 'let', 'in', 'inherit', 'rec', 'if', 'then', 'else',
  'assert', 'null', 'true', 'false', 'import', 'builtins',
]);

// Package namespace attribute set families. A flat list can't cover versioned variants
// (linuxPackages_latest, python312Packages, etc.) without enumerating every future name.
const PKG_IGNORE_PATTERNS = [
  /^linuxKernel$/,
  /^linuxPackages(_.+)?$/,     // linuxPackages, linuxPackages_latest, _zen, _hardened, …
  /^python\d*Packages$/,       // python2Packages, python3Packages, python311Packages, …
  /^haskell\.?Packages$/,      // haskellPackages
  /^ruby\d*Packages$/,
  /^perl\d*Packages$/,
  /^nodePackages(_.+)?$/,
  /^phpPackages$/,
  /^rPackages$/,
];

function isIgnoredToken(token) {
  return PKG_IGNORE.has(token) || PKG_IGNORE_PATTERNS.some(re => re.test(token));
}

// Top-level NixOS option namespaces — anything else is likely a let binding
export const OPTION_NAMESPACES = new Set([
  'boot', 'hardware', 'networking', 'services', 'users', 'environment',
  'programs', 'nix', 'system', 'security', 'fileSystems', 'swapDevices',
  'virtualisation', 'fonts', 'i18n', 'time', 'sound', 'console',
  'documentation', 'specialisation', 'containers', 'assertions', 'warnings',
  'xdg', 'gtk', 'qt', 'location', 'power', 'nixpkgs', 'snapraid', 'ids', 'lib',
]);

// Extract bare identifiers from inside a `with <scope>; [ ... ]` block
function extractWithBlock(inner) {
  const names = new Set();
  for (const m of inner.matchAll(/\b([a-zA-Z][a-zA-Z0-9_-]*)\b/g)) {
    if (!isIgnoredToken(m[1])) names.add(m[1]);
  }
  return names;
}

export function extractPackageReferences(nixSource) {
  const packages = new Set();

  // `with pkgs; [ ... ]` and `with ps; [ ... ]` blocks (multiline-safe: [^\]] matches \n)
  const withBlockRe = /with\s+(?:pkgs|ps)\s*;\s*\[([^\]]*)\]/g;
  let m;
  while ((m = withBlockRe.exec(nixSource)) !== null) {
    for (const name of extractWithBlock(m[1])) packages.add(name);
  }

  // `pkgs.NAME` references (capture first segment only — pkgs.python3.withPackages → python3)
  const pkgsDotRe = /pkgs\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
  while ((m = pkgsDotRe.exec(nixSource)) !== null) {
    if (!isIgnoredToken(m[1])) packages.add(m[1]);
  }

  return [...packages].sort();
}

export function extractOptionReferences(nixSource) {
  const options = new Set();
  const lines = nixSource.split('\n');

  // pathStack holds full dotted prefixes; depthStack holds the brace depth at which each was pushed
  const pathStack = [];
  const depthStack = [];
  let depth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;
    const net = opens - closes;
    const newDepth = depth + net;

    // Pop entries going out of scope before processing this line's content
    while (depthStack.length > 0 && newDepth < depthStack[depthStack.length - 1]) {
      pathStack.pop();
      depthStack.pop();
    }

    if (net > 0) {
      // Line opens a block — look for `path = {` to push a new prefix
      // Hyphens appear in real NixOS paths: boot.loader.systemd-boot.enable
      const bm = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_.-]*)\s*=\s*\{/);
      if (bm) {
        const prefix = pathStack.length > 0
          ? `${pathStack[pathStack.length - 1]}.${bm[1]}`
          : bm[1];
        pathStack.push(prefix);
        depthStack.push(newDepth);
      }
    } else if (opens === 0 && closes === 0) {
      // No braces — leaf assignment
      const lm = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_.-]*)\s*=/);
      if (lm) {
        const fullPath = pathStack.length > 0
          ? `${pathStack[pathStack.length - 1]}.${lm[1]}`
          : lm[1];
        if (OPTION_NAMESPACES.has(fullPath.split('.')[0])) {
          options.add(fullPath);
        }
      }
    }
    // net < 0 (only closes): stack was already popped above; no new pushes

    depth = newDepth;
  }

  return [...options].sort();
}
