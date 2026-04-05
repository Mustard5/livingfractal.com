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
